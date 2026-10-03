import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { resolveTenantSlug, withTenant, type Db, type TenantTx } from "@/db/client";
import { appUser, otpChallenge, tenant, userRole, userSession } from "@/db/schema";
import { isLocale, type Locale } from "@/i18n/config";
import { toLatinDigits } from "@/lib/digits";
import { normalizeBdPhone } from "@/lib/phone";
import { recordAudit } from "@/modules/audit/log";
import { hashSessionToken, hashSignInCode, newSessionToken, newSignInCode, sameHash } from "./secrets";
import { signInCodeText, type SmsSender } from "./sms";

/**
 * Phone + SMS code sign-in for one somiti.
 *
 * All times come from the database clock (now()), never the app server's,
 * so expiry and cooldowns hold even when the two clocks drift apart.
 *
 * Responses never say whether a phone number is registered: an unknown or
 * inactive number gets the same "sent" answer as a real one, and a wrong
 * code for it fails the same way as a wrong code for a real user.
 */

export const CODE_TTL_MINUTES = 5;
export const MAX_CODE_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_CODES_PER_HOUR = 5;
export const SESSION_TTL_DAYS = 30;
/** How stale last_seen_at may get before a request refreshes it. */
const LAST_SEEN_REFRESH_MINUTES = 15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RequestCodeResult =
  | { status: "sent"; resendInSeconds: number }
  | { status: "invalid_phone" }
  | { status: "unknown_somiti" }
  | { status: "too_many"; retryInSeconds: number };

export type VerifyCodeResult =
  | { ok: true; cookie: string; expiresAt: Date; locale: Locale | null }
  | { ok: false; reason: "invalid"; attemptsLeft?: number }
  | { ok: false; reason: "expired" | "locked" };

export interface SessionUser {
  sessionId: string;
  tenantId: string;
  userId: string;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  locale: Locale | null;
  roles: string[];
  somiti: { slug: string; nameEn: string | null; nameBn: string | null; defaultLocale: Locale };
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

async function findActiveUser({ tx, tenantId }: TenantTx, phone: string) {
  const [user] = await tx
    .select()
    .from(appUser)
    .where(and(eq(appUser.tenantId, tenantId), eq(appUser.phone, phone), eq(appUser.isActive, true)));
  return user;
}

/** Step one: text a fresh code to the phone, if it belongs to an active user of the somiti. */
export async function requestSignInCode(
  db: Db,
  input: { slug: string; phone: string; sms: SmsSender },
): Promise<RequestCodeResult> {
  const phone = normalizeBdPhone(input.phone);
  if (!phone) return { status: "invalid_phone" };
  const tenantId = await resolveTenantSlug(db, normalizeSlug(input.slug));
  if (!tenantId) return { status: "unknown_somiti" };

  const outcome = await withTenant(db, tenantId, async (ctx) => {
    const user = await findActiveUser(ctx, phone);
    if (!user) return { result: { status: "sent", resendInSeconds: RESEND_COOLDOWN_SECONDS } as const };

    const [latest] = await ctx.tx
      .select({
        wait: sql<number>`ceil(${RESEND_COOLDOWN_SECONDS} - extract(epoch from now() - ${otpChallenge.createdAt}))::int`,
      })
      .from(otpChallenge)
      .where(and(eq(otpChallenge.tenantId, tenantId), eq(otpChallenge.userId, user.id)))
      .orderBy(desc(otpChallenge.createdAt))
      .limit(1);
    // The page hides "resend" during the cooldown, so only a scripted request lands here.
    if (latest && latest.wait > 0) return { result: { status: "sent", resendInSeconds: latest.wait } as const };

    const [recent] = await ctx.tx
      .select({ n: count() })
      .from(otpChallenge)
      .where(
        and(
          eq(otpChallenge.tenantId, tenantId),
          eq(otpChallenge.userId, user.id),
          gt(otpChallenge.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) {
      return { result: { status: "too_many", retryInSeconds: 60 * 60 } as const };
    }

    const code = newSignInCode();
    const id = randomUUID();
    await ctx.tx.insert(otpChallenge).values({
      id,
      tenantId,
      userId: user.id,
      codeHash: hashSignInCode(id, code),
      expiresAt: sql`now() + make_interval(mins => ${CODE_TTL_MINUTES})`,
    });
    const [somiti] = await ctx.tx
      .select({ defaultLocale: tenant.defaultLocale })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    const locale = user.locale ?? somiti?.defaultLocale ?? "en";
    return {
      result: { status: "sent", resendInSeconds: RESEND_COOLDOWN_SECONDS } as const,
      message: { to: phone, text: signInCodeText(code, CODE_TTL_MINUTES, locale) },
    };
  });

  // Sent only after the challenge is committed, so a code never arrives that the database doesn't know.
  if ("message" in outcome && outcome.message) await input.sms.send(outcome.message.to, outcome.message.text);
  return outcome.result;
}

/** Step two: check the code and, if it is right, open a session. */
export async function verifySignInCode(
  db: Db,
  input: { slug: string; phone: string; code: string; device?: string },
): Promise<VerifyCodeResult> {
  const phone = normalizeBdPhone(input.phone);
  const code = toLatinDigits(input.code).replace(/\s/g, "");
  if (!phone || !/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };
  const tenantId = await resolveTenantSlug(db, normalizeSlug(input.slug));
  if (!tenantId) return { ok: false, reason: "invalid" };

  return withTenant(db, tenantId, async (ctx): Promise<VerifyCodeResult> => {
    const user = await findActiveUser(ctx, phone);
    if (!user) return { ok: false, reason: "invalid" };

    const [row] = await ctx.tx
      .select({ challenge: otpChallenge, expired: sql<boolean>`${otpChallenge.expiresAt} <= now()` })
      .from(otpChallenge)
      .where(and(eq(otpChallenge.tenantId, tenantId), eq(otpChallenge.userId, user.id)))
      .orderBy(desc(otpChallenge.createdAt))
      .limit(1)
      .for("update");
    const challenge = row?.challenge;
    if (!challenge || challenge.consumedAt) return { ok: false, reason: "invalid" };
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: "locked" };
    if (row.expired) return { ok: false, reason: "expired" };

    if (!sameHash(challenge.codeHash, hashSignInCode(challenge.id, code))) {
      const attempts = challenge.attempts + 1;
      await ctx.tx.update(otpChallenge).set({ attempts }).where(eq(otpChallenge.id, challenge.id));
      return attempts >= MAX_CODE_ATTEMPTS
        ? { ok: false, reason: "locked" }
        : { ok: false, reason: "invalid", attemptsLeft: MAX_CODE_ATTEMPTS - attempts };
    }

    await ctx.tx.update(otpChallenge).set({ consumedAt: sql`now()` }).where(eq(otpChallenge.id, challenge.id));
    const token = newSessionToken();
    const [session] = await ctx.tx
      .insert(userSession)
      .values({
        tenantId,
        userId: user.id,
        tokenHash: hashSessionToken(token),
        device: input.device,
        expiresAt: sql`now() + make_interval(days => ${SESSION_TTL_DAYS})`,
      })
      .returning({ id: userSession.id, expiresAt: userSession.expiresAt });
    await recordAudit(ctx, {
      actorUserId: user.id,
      action: "auth.sign_in",
      entityType: "user_session",
      entityId: session!.id,
      device: input.device,
    });
    return { ok: true, cookie: `${tenantId}.${token}`, expiresAt: session!.expiresAt, locale: user.locale };
  });
}

function parseCookie(cookie: string | undefined): { tenantId: string; token: string } | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  const tenantId = cookie.slice(0, dot);
  const token = cookie.slice(dot + 1);
  return dot > 0 && UUID.test(tenantId) && token.length >= 32 ? { tenantId, token } : null;
}

/** The signed-in user for a session cookie, or null if it is missing, expired or revoked. */
export async function readSession(db: Db, cookie: string | undefined): Promise<SessionUser | null> {
  const parsed = parseCookie(cookie);
  if (!parsed) return null;
  return withTenant(db, parsed.tenantId, async ({ tx, tenantId }) => {
    const [row] = await tx
      .select({
        session: userSession,
        user: appUser,
        somiti: tenant,
        stale: sql<boolean>`${userSession.lastSeenAt} < now() - make_interval(mins => ${LAST_SEEN_REFRESH_MINUTES})`,
      })
      .from(userSession)
      .innerJoin(appUser, and(eq(appUser.tenantId, userSession.tenantId), eq(appUser.id, userSession.userId)))
      .innerJoin(tenant, eq(tenant.id, userSession.tenantId))
      .where(
        and(
          eq(userSession.tenantId, tenantId),
          eq(userSession.tokenHash, hashSessionToken(parsed.token)),
          isNull(userSession.revokedAt),
          gt(userSession.expiresAt, sql`now()`),
          eq(appUser.isActive, true),
        ),
      );
    if (!row) return null;

    if (row.stale) {
      await tx.update(userSession).set({ lastSeenAt: sql`now()` }).where(eq(userSession.id, row.session.id));
    }
    const roles = await tx
      .select({ role: userRole.role })
      .from(userRole)
      .where(and(eq(userRole.tenantId, tenantId), eq(userRole.userId, row.user.id)));

    return {
      sessionId: row.session.id,
      tenantId,
      userId: row.user.id,
      nameEn: row.user.nameEn,
      nameBn: row.user.nameBn,
      phone: row.user.phone,
      locale: isLocale(row.user.locale) ? row.user.locale : null,
      roles: roles.map((r) => r.role),
      somiti: {
        slug: row.somiti.slug,
        nameEn: row.somiti.nameEn,
        nameBn: row.somiti.nameBn,
        defaultLocale: row.somiti.defaultLocale,
      },
    };
  });
}

/** Ends the session behind a cookie. Safe to call with a stale or missing cookie. */
export async function revokeSession(db: Db, cookie: string | undefined, device?: string): Promise<void> {
  const parsed = parseCookie(cookie);
  if (!parsed) return;
  await withTenant(db, parsed.tenantId, async (ctx) => {
    const [revoked] = await ctx.tx
      .update(userSession)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(userSession.tenantId, ctx.tenantId),
          eq(userSession.tokenHash, hashSessionToken(parsed.token)),
          isNull(userSession.revokedAt),
        ),
      )
      .returning({ id: userSession.id, userId: userSession.userId });
    if (revoked) {
      await recordAudit(ctx, {
        actorUserId: revoked.userId,
        action: "auth.sign_out",
        entityType: "user_session",
        entityId: revoked.id,
        device,
      });
    }
  });
}
