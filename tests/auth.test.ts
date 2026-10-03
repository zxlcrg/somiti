import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { resolveTenantSlug, withTenant } from "../src/db/client";
import { appUser, auditLog, userRole } from "../src/db/schema";
import { toLatinDigits } from "../src/lib/digits";
import { formatBdPhone, normalizeBdPhone } from "../src/lib/phone";
import {
  MAX_CODE_ATTEMPTS,
  MAX_CODES_PER_HOUR,
  readSession,
  requestSignInCode,
  revokeSession,
  verifySignInCode,
  type SmsSender,
} from "../src/modules/auth";
import { createTenant } from "../src/modules/tenancy/create-tenant";
import { app, owner } from "./helpers";

function smsOutbox() {
  const sent: { to: string; text: string }[] = [];
  const sms: SmsSender = {
    async send(to, text) {
      sent.push({ to, text });
    },
  };
  const lastCode = () => /(\d{6})/.exec(toLatinDigits(sent.at(-1)?.text ?? ""))?.[1] ?? "";
  return { sent, sms, lastCode };
}

let phoneSeq = 0;
/** A unique, valid Bangladeshi mobile number per call. */
function newPhone(): string {
  phoneSeq += 1;
  return `+88017${String(Date.now() % 1e6).padStart(6, "0")}${String(phoneSeq % 100).padStart(2, "0")}`;
}

async function newSomiti(defaultLocale: "en" | "bn" = "en") {
  const slug = `auth-${randomUUID()}`;
  const phone = newPhone();
  const created = await createTenant(app.db, {
    slug,
    nameEn: "Auth Somiti",
    defaultLocale,
    businessDate: "2026-10-03",
    admin: { nameEn: "Rahima", nameBn: "রহিমা", phone },
  });
  return { ...created, slug, phone };
}

/** Runs SQL as the table owner, for moving timestamps in tests. RLS is forced for the owner too. */
function asOwner(tenantId: string, query: ReturnType<typeof sql>) {
  return withTenant(owner.db, tenantId, ({ tx }) => tx.execute(query));
}

async function signIn(s: Awaited<ReturnType<typeof newSomiti>>) {
  const box = smsOutbox();
  await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
  const result = await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: box.lastCode(), device: "test" });
  if (!result.ok) throw new Error(`sign-in failed: ${result.reason}`);
  return result;
}

describe("Bangladeshi phone numbers", () => {
  it("accepts the usual ways people write them", () => {
    for (const input of ["01712345678", "+8801712345678", "8801712345678", "01712-345678", "০১৭১২৩৪৫৬৭৮", " 017 1234 5678 "]) {
      expect(normalizeBdPhone(input)).toBe("+8801712345678");
    }
  });

  it("rejects numbers that are not BD mobiles", () => {
    for (const input of ["", "0171234567", "017123456789", "01212345678", "+4401712345678", "abc"]) {
      expect(normalizeBdPhone(input)).toBeNull();
    }
  });

  it("formats for display", () => {
    expect(formatBdPhone("+8801712345678")).toBe("01712-345678");
  });
});

describe("finding a somiti by its code", () => {
  it("finds exactly the somiti whose code was given, and nothing without one", async () => {
    const s = await newSomiti();
    expect(await resolveTenantSlug(app.db, s.slug)).toBe(s.tenantId);
    expect(await resolveTenantSlug(app.db, `${s.slug}-nope`)).toBeNull();
    const visible = await app.db.execute(sql`select count(*)::int as n from tenant`);
    expect(visible.rows[0]).toEqual({ n: 0 });
  });
});

describe("sign-in with an SMS code", () => {
  it("texts a code and signs in with it", async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    const sent = await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
    expect(sent).toEqual({ status: "sent", resendInSeconds: 60 });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.to).toBe(s.phone);
    expect(box.lastCode()).toMatch(/^\d{6}$/);

    const result = await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: box.lastCode() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookie.startsWith(`${s.tenantId}.`)).toBe(true);

    const user = await readSession(app.db, result.cookie);
    expect(user).toMatchObject({ tenantId: s.tenantId, userId: s.adminUserId, nameBn: "রহিমা", roles: ["admin"] });
    expect(user?.somiti.slug).toBe(s.slug);

    const audit = await withTenant(app.db, s.tenantId, ({ tx }) =>
      tx.select().from(auditLog).where(sql`${auditLog.action} = 'auth.sign_in'`),
    );
    expect(audit).toHaveLength(1);
  });

  it("takes the code and number in Bangla digits, and texts in the somiti's language", async () => {
    const s = await newSomiti("bn");
    const box = smsOutbox();
    const local = s.phone.replace("+88", "").replace(/\d/g, (d) => String.fromCharCode(0x09e6 + Number(d)));
    await requestSignInCode(app.db, { slug: s.slug.toUpperCase(), phone: local, sms: box.sms });
    expect(box.sent[0]!.text).toContain("সমিতি");
    const banglaCode = box.lastCode().replace(/\d/g, (d) => String.fromCharCode(0x09e6 + Number(d)));
    const result = await verifySignInCode(app.db, { slug: s.slug, phone: local, code: banglaCode });
    expect(result.ok).toBe(true);
  });

  it("does not reveal whether a number is registered", async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    const unknown = newPhone();
    expect(await requestSignInCode(app.db, { slug: s.slug, phone: unknown, sms: box.sms })).toEqual({
      status: "sent",
      resendInSeconds: 60,
    });
    expect(box.sent).toHaveLength(0);
    expect(await verifySignInCode(app.db, { slug: s.slug, phone: unknown, code: "123456" })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("sends nothing to a deactivated user", async () => {
    const s = await newSomiti();
    await withTenant(app.db, s.tenantId, ({ tx }) =>
      tx.update(appUser).set({ isActive: false }).where(sql`${appUser.id} = ${s.adminUserId}`),
    );
    const box = smsOutbox();
    expect((await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms })).status).toBe("sent");
    expect(box.sent).toHaveLength(0);
  });

  it("tells apart a bad number and an unknown somiti", async () => {
    const s = await newSomiti();
    const { sms } = smsOutbox();
    expect(await requestSignInCode(app.db, { slug: s.slug, phone: "12345", sms })).toEqual({ status: "invalid_phone" });
    expect(await requestSignInCode(app.db, { slug: "no-such-somiti", phone: s.phone, sms })).toEqual({
      status: "unknown_somiti",
    });
  });

  it(`locks the code after ${MAX_CODE_ATTEMPTS} wrong tries, even for the right code`, async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
    const right = box.lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let left = MAX_CODE_ATTEMPTS - 1; left > 0; left--) {
      expect(await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: wrong })).toEqual({
        ok: false,
        reason: "invalid",
        attemptsLeft: left,
      });
    }
    expect(await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: wrong })).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: right })).toEqual({
      ok: false,
      reason: "locked",
    });
  });

  it("rejects an expired code", async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
    await asOwner(s.tenantId, sql`update otp_challenge set expires_at = now() - interval '1 second'`);
    expect(await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: box.lastCode() })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts a code only once", async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
    const code = box.lastCode();
    expect((await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code })).ok).toBe(true);
    expect(await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code })).toEqual({ ok: false, reason: "invalid" });
  });

  it("only honours the newest code", async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
    const first = box.lastCode();
    await asOwner(s.tenantId, sql`update otp_challenge set created_at = created_at - interval '2 minutes'`);
    await requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });
    if (first !== box.lastCode()) {
      expect((await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: first })).ok).toBe(false);
    }
    expect((await verifySignInCode(app.db, { slug: s.slug, phone: s.phone, code: box.lastCode() })).ok).toBe(true);
  });

  it("waits a minute between codes and caps them per hour", async () => {
    const s = await newSomiti();
    const box = smsOutbox();
    const ask = () => requestSignInCode(app.db, { slug: s.slug, phone: s.phone, sms: box.sms });

    await ask();
    const again = await ask();
    expect(again.status).toBe("sent");
    expect(box.sent).toHaveLength(1);

    for (let i = 1; i < MAX_CODES_PER_HOUR; i++) {
      await asOwner(s.tenantId, sql`update otp_challenge set created_at = created_at - interval '2 minutes'`);
      await ask();
    }
    expect(box.sent).toHaveLength(MAX_CODES_PER_HOUR);
    await asOwner(s.tenantId, sql`update otp_challenge set created_at = created_at - interval '2 minutes'`);
    expect((await ask()).status).toBe("too_many");
    expect(box.sent).toHaveLength(MAX_CODES_PER_HOUR);
  });
});

describe("sessions", () => {
  it("ends on sign-out", async () => {
    const s = await newSomiti();
    const { cookie } = await signIn(s);
    expect(await readSession(app.db, cookie)).not.toBeNull();
    await revokeSession(app.db, cookie, "test");
    expect(await readSession(app.db, cookie)).toBeNull();
    const audit = await withTenant(app.db, s.tenantId, ({ tx }) =>
      tx.select().from(auditLog).where(sql`${auditLog.action} = 'auth.sign_out'`),
    );
    expect(audit).toHaveLength(1);
  });

  it("ends when it expires or the user is deactivated", async () => {
    const s = await newSomiti();
    const first = await signIn(s);
    await asOwner(s.tenantId, sql`update user_session set expires_at = now() - interval '1 second'`);
    expect(await readSession(app.db, first.cookie)).toBeNull();

    await asOwner(s.tenantId, sql`update otp_challenge set created_at = created_at - interval '2 minutes'`);
    const second = await signIn(s);
    expect(await readSession(app.db, second.cookie)).not.toBeNull();
    await withTenant(app.db, s.tenantId, ({ tx }) =>
      tx.update(appUser).set({ isActive: false }).where(sql`${appUser.id} = ${s.adminUserId}`),
    );
    expect(await readSession(app.db, second.cookie)).toBeNull();
  });

  it("can't be read with another somiti's id or a changed token", async () => {
    const a = await newSomiti();
    const b = await newSomiti();
    const { cookie } = await signIn(a);
    const token = cookie.slice(cookie.indexOf(".") + 1);
    expect(await readSession(app.db, `${b.tenantId}.${token}`)).toBeNull();
    expect(await readSession(app.db, `${a.tenantId}.${token.slice(0, -1)}x`)).toBeNull();
    for (const junk of [undefined, "", "nonsense", `not-a-uuid.${token}`, `${a.tenantId}.short`]) {
      expect(await readSession(app.db, junk)).toBeNull();
    }
  });

  it("reports every role the user holds", async () => {
    const s = await newSomiti();
    await withTenant(app.db, s.tenantId, ({ tx }) =>
      tx.insert(userRole).values({ tenantId: s.tenantId, userId: s.adminUserId, role: "cashier" }),
    );
    const { cookie } = await signIn(s);
    expect((await readSession(app.db, cookie))?.roles.sort()).toEqual(["admin", "cashier"]);
  });
});
