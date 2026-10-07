import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, member, smsOutbox, userRole } from "../src/db/schema";
import { toBanglaDigits } from "../src/lib/digits";
import { admitMember } from "../src/modules/members";
import { depositText, flushOutbox, MAX_SMS_ATTEMPTS, withdrawalText } from "../src/modules/messages";
import { approveWithdrawal, createProduct, deposit, getReceipt, openAccount, requestWithdrawal } from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

async function saver(t: TestTenant, commLocale?: "bn") {
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Saver", phone: "01711111111", commLocale }, { userId: t.adminUserId }));
  if (!m.ok) throw new Error("admit failed");
  const p = await t.run((ctx) => createProduct(ctx, { code: "GS", nameEn: "General", frequency: "flexible" }, { userId: t.adminUserId }));
  if (!p.ok) throw new Error("product failed");
  const a = await t.run((ctx) => openAccount(ctx, { memberId: m.member.id, productId: p.id }, { userId: t.adminUserId }));
  if (!a.ok) throw new Error("open failed");
  return { memberId: m.member.id, accountId: a.accountId, accountNo: a.accountNo };
}

function pay(t: TestTenant, accountId: string, amount: string, idempotencyKey = randomUUID()) {
  return t.run((ctx) => deposit(ctx, { accountId, amount, method: "cash", idempotencyKey }, { userId: t.adminUserId, channel: "office" }));
}

const outbox = (t: TestTenant) => t.run(({ tx }) => tx.select().from(smsOutbox).orderBy(smsOutbox.createdAt));

describe("member SMS wording", () => {
  const m = { somiti: "Demo Somiti", productCode: "DS", accountNo: 3, entryNo: 18n, amount: 1500_00n, balance: 2000_50n };
  it("is short, and English avoids the taka sign", () => {
    expect(depositText(m, "en")).toBe("Demo Somiti: Tk 1,500 deposited to DS a/c 3, receipt 18. Balance Tk 2,000.50.");
    expect(depositText({ ...m, fine: 10_00n }, "en")).toContain(" Late fine Tk 10.");
    expect(withdrawalText(m, "en")).toBe("Demo Somiti: Tk 1,500 withdrawn from DS a/c 3, payment 18. Balance Tk 2,000.50.");
    expect(depositText({ ...m, somiti: "ডেমো সমিতি" }, "bn")).toBe("ডেমো সমিতি: DS হিসাব ৩-এ ৳১,৫০০ জমা, রসিদ ১৮। ব্যালান্স ৳২,০০০.৫০।");
  });
});

describe("SMS outbox", () => {
  it("queues one message per deposit, in the member's language, and never twice for a retry", async () => {
    const t = await newTenant();
    const { accountId, accountNo } = await saver(t, "bn");
    const key = randomUUID();
    const r = await pay(t, accountId, "500", key);
    await pay(t, accountId, "500", key);
    if (!r.ok) throw new Error("deposit failed");
    const rows = await outbox(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "deposit", refId: r.deposit.journalEntryId, toPhone: "+8801711111111", status: "queued", attempts: 0 });
    expect(rows[0]!.body).toContain(`হিসাব ${toBanglaDigits(String(accountNo))}-এ ৳৫০০ জমা`);
    expect((await t.run((ctx) => getReceipt(ctx, r.deposit.id)))).toMatchObject({ sms: "queued", memberLocale: "bn", txn: { amount: 500_00n } });
  });

  it("tells the member when a withdrawal is paid out, with the new balance", async () => {
    const t = await newTenant();
    const { accountId } = await saver(t);
    await pay(t, accountId, "1000");
    const secretary = await t.run(async ({ tx, tenantId }) => {
      const [u] = await tx.insert(appUser).values({ tenantId, nameEn: "Sec", phone: `+8801${Math.floor(Math.random() * 1e9)}` }).returning({ id: appUser.id });
      await tx.insert(userRole).values({ tenantId, userId: u!.id, role: "secretary" });
      return u!.id;
    });
    const w = await t.run((ctx) => requestWithdrawal(ctx, { accountId, amount: "300", method: "cash", submitKey: randomUUID() }, { userId: t.adminUserId }));
    if (!w.ok) throw new Error("request failed");
    await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: w.withdrawalId, userId: secretary }));
    const rows = await outbox(t);
    expect(rows.map((r) => r.kind)).toEqual(["deposit", "withdrawal"]);
    expect(rows[1]!.body).toMatch(/Tk 300 withdrawn .* Balance Tk 700\.$/);
  });

  it("sends queued messages, retries failures, and gives up after a few", async () => {
    const t = await newTenant();
    const { accountId } = await saver(t);
    await pay(t, accountId, "100");
    await pay(t, accountId, "200");
    const sent: string[] = [];
    const ok = { send: async (to: string, text: string) => void sent.push(`${to} ${text}`) };
    const down = { send: async () => Promise.reject(new Error("gateway down")) };

    expect(await t.run((ctx) => flushOutbox(ctx, down, 1))).toEqual({ sent: 0, failed: 1 });
    expect((await outbox(t))[0]).toMatchObject({ status: "queued", attempts: 1, lastError: "gateway down" });
    expect(await t.run((ctx) => flushOutbox(ctx, ok))).toEqual({ sent: 2, failed: 0 });
    expect(sent).toHaveLength(2);
    expect((await outbox(t)).every((r) => r.status === "sent" && r.sentAt && r.lastError === null)).toBe(true);
    expect(await t.run((ctx) => flushOutbox(ctx, ok))).toEqual({ sent: 0, failed: 0 });

    await pay(t, accountId, "300");
    for (let i = 0; i < MAX_SMS_ATTEMPTS; i++) await t.run((ctx) => flushOutbox(ctx, down));
    const last = (await outbox(t))[2]!;
    expect(last).toMatchObject({ status: "failed", attempts: MAX_SMS_ATTEMPTS });
    expect(await t.run((ctx) => flushOutbox(ctx, ok))).toEqual({ sent: 0, failed: 0 });
  });

  it("keeps sent messages as they were and stays within its somiti", async () => {
    const t = await newTenant();
    const other = await newTenant();
    const { accountId } = await saver(t);
    await pay(t, accountId, "100");
    await t.run((ctx) => flushOutbox(ctx, { send: async () => {} }));
    const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });
    await expect(t.run(({ tx }) => tx.execute(sql`update sms_outbox set body = 'x'`))).rejects.toMatchObject(code("42501"));
    await expect(t.run(({ tx }) => tx.execute(sql`update sms_outbox set status = 'queued', sent_at = null`))).rejects.toMatchObject({ code: "APPEND_ONLY" });
    await expect(t.run(({ tx }) => tx.execute(sql`delete from sms_outbox`))).rejects.toMatchObject(code("42501"));
    expect(await other.run(({ tx }) => tx.select().from(smsOutbox))).toEqual([]);
    expect(await other.run(({ tx }) => tx.select().from(member).where(eq(member.tenantId, t.tenantId)))).toEqual([]);
  });
});
