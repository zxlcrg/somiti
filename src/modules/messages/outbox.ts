import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, smsOutbox, tenant } from "@/db/schema";
import type { Locale } from "@/i18n/config";
import type { SmsSender } from "@/modules/auth";

/** Gives up on a message after this many failed sends; it then shows as failed. */
export const MAX_SMS_ATTEMPTS = 5;

/**
 * Queues a message to a member in their language (or the somiti's), inside
 * the caller's transaction. A second call for the same kind and entry is a
 * no-op, so replays never text twice.
 */
export async function queueMemberSms(
  ctx: TenantTx,
  input: { memberId: string; kind: "deposit" | "withdrawal"; refId: string; text: (locale: Locale, somiti: string) => string },
): Promise<void> {
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .select({
      phone: member.phone,
      commLocale: member.commLocale,
      defaultLocale: tenant.defaultLocale,
      somitiEn: tenant.nameEn,
      somitiBn: tenant.nameBn,
    })
    .from(member)
    .innerJoin(tenant, eq(tenant.id, member.tenantId))
    .where(and(eq(member.tenantId, tenantId), eq(member.id, input.memberId)));
  if (!row) return;
  const locale = row.commLocale ?? row.defaultLocale;
  const somiti = (locale === "bn" ? (row.somitiBn ?? row.somitiEn) : (row.somitiEn ?? row.somitiBn)) ?? "";
  await tx
    .insert(smsOutbox)
    .values({ tenantId, memberId: input.memberId, toPhone: row.phone, body: input.text(locale, somiti), kind: input.kind, refId: input.refId })
    .onConflictDoNothing({ target: [smsOutbox.tenantId, smsOutbox.kind, smsOutbox.refId] });
}

/**
 * Sends queued messages, oldest first. Each send is recorded as it
 * happens; a failure stays queued for the next flush until it has failed
 * MAX_SMS_ATTEMPTS times. Concurrent flushes skip each other's rows.
 */
export async function flushOutbox(ctx: TenantTx, sender: SmsSender, limit = 20): Promise<{ sent: number; failed: number }> {
  const { tx, tenantId } = ctx;
  const rows = await tx
    .select({ id: smsOutbox.id, toPhone: smsOutbox.toPhone, body: smsOutbox.body, attempts: smsOutbox.attempts })
    .from(smsOutbox)
    .where(and(eq(smsOutbox.tenantId, tenantId), eq(smsOutbox.status, "queued"), lt(smsOutbox.attempts, MAX_SMS_ATTEMPTS)))
    .orderBy(asc(smsOutbox.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await sender.send(r.toPhone, r.body);
      await tx
        .update(smsOutbox)
        .set({ status: "sent", attempts: r.attempts + 1, sentAt: sql`now()`, lastError: null })
        .where(and(eq(smsOutbox.tenantId, tenantId), eq(smsOutbox.id, r.id)));
      sent++;
    } catch (err) {
      const attempts = r.attempts + 1;
      await tx
        .update(smsOutbox)
        .set({ status: attempts >= MAX_SMS_ATTEMPTS ? "failed" : "queued", attempts, lastError: String(err instanceof Error ? err.message : err).slice(0, 300) })
        .where(and(eq(smsOutbox.tenantId, tenantId), eq(smsOutbox.id, r.id)));
      failed++;
    }
  }
  return { sent, failed };
}

export type SmsState = "queued" | "sent" | "failed";

/** Delivery state of the messages for these journal entries, by entry id. */
export async function smsStateFor(ctx: TenantTx, refIds: string[]): Promise<Map<string, SmsState>> {
  if (refIds.length === 0) return new Map();
  const rows = await ctx.tx
    .select({ refId: smsOutbox.refId, status: smsOutbox.status })
    .from(smsOutbox)
    .where(and(eq(smsOutbox.tenantId, ctx.tenantId), inArray(smsOutbox.refId, refIds)));
  return new Map(rows.map((r) => [r.refId, r.status]));
}
