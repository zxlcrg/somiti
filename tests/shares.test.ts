import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { member, shareTransaction, tenant } from "../src/db/schema";
import { toBanglaDigits } from "../src/lib/digits";
import { getEntry, reverseEntry, trialBalance } from "../src/modules/ledger";
import {
  admitMember,
  buyShares,
  canRecordPayments,
  parseShareCount,
  shareHolding,
  type BuySharesInput,
} from "../src/modules/members";
import { newTenant, type TestTenant } from "./helpers";

const BUSINESS_DATE = "2026-10-03";

async function memberOf(t: TestTenant) {
  const r = await t.run((ctx) => admitMember(ctx, { nameEn: "Shareholder", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!r.ok) throw new Error("admit failed");
  return r.member;
}

function buy(t: TestTenant, input: Omit<BuySharesInput, "idempotencyKey"> & { idempotencyKey?: string }) {
  return t.run((ctx) =>
    buyShares(ctx, { idempotencyKey: randomUUID(), ...input }, { userId: t.adminUserId, device: "test" }),
  );
}

describe("share counts", () => {
  it("accepts whole numbers from 1 to 10,000, in either script", () => {
    expect(parseShareCount("5")).toBe(5);
    expect(parseShareCount(toBanglaDigits("25"))).toBe(25);
    expect(parseShareCount(10_000)).toBe(10_000);
    for (const bad of ["", "0", "1.5", "-2", "10001", "abc"]) expect(parseShareCount(bad)).toBeNull();
  });

  it("is the cashier's job", () => {
    expect(canRecordPayments(["cashier"])).toBe(true);
    expect(canRecordPayments(["admin", "president", "secretary", "field_collector", "member"])).toBe(false);
  });
});

describe("buying shares", () => {
  it("posts Dr cash, Cr share capital on the member's line, and records the count", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    const result = await buy(t, { memberId: m.id, shares: "5", method: "cash" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purchase).toMatchObject({ shares: 5, price: 100_00n, amount: 500_00n, paymentMethod: "cash", reversed: false });
    expect(result.purchase.entryNo).toBeGreaterThan(0n);

    const { entry, lines } = await t.run((ctx) => getEntry(ctx, result.purchase.journalEntryId));
    expect(entry.source).toBe("share_purchase");
    expect(entry.businessDate).toBe(BUSINESS_DATE);
    expect(lines.map((l) => [l.accountId, l.debit, l.credit, l.memberId])).toEqual([
      [t.accounts.cash_in_hand, 500_00n, 0n, null],
      [t.accounts.share_capital, 0n, 500_00n, m.id],
    ]);

    const tb = await t.run((ctx) => trialBalance(ctx, BUSINESS_DATE));
    expect(tb.rows.find((r) => r.code === "3100")?.credit).toBe(500_00n);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    const holding = await t.run((ctx) => shareHolding(ctx, m.id));
    expect(holding).toMatchObject({ shares: 5, amount: 500_00n });
    expect(holding.transactions).toHaveLength(1);
  });

  it("takes bank and mobile-wallet payments, and wants the wallet's transaction ID", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    expect((await buy(t, { memberId: m.id, shares: 2, method: "bank", paymentRef: "SLIP-77" })).ok).toBe(true);
    expect(await buy(t, { memberId: m.id, shares: 2, method: "mobile_wallet", paymentRef: "  " })).toEqual({
      ok: false,
      errors: { paymentRef: "ref_required" },
    });
    const wallet = await buy(t, { memberId: m.id, shares: 3, method: "mobile_wallet", paymentRef: "BK8X2Q9" });
    expect(wallet.ok && wallet.purchase.paymentRef).toBe("BK8X2Q9");
    expect(await t.run((ctx) => shareHolding(ctx, m.id))).toMatchObject({ shares: 5, amount: 500_00n });
  });

  it("uses the somiti's share price", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await t.run(({ tx, tenantId }) => tx.update(tenant).set({ sharePrice: 50_00n }).where(sql`${tenant.id} = ${tenantId}`));
    const r = await buy(t, { memberId: m.id, shares: 4, method: "cash" });
    expect(r.ok && [r.purchase.price, r.purchase.amount]).toEqual([50_00n, 200_00n]);
  });

  it("posts once when the same form is sent twice, and refuses a reused key for a different purchase", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    const key = randomUUID();
    const first = await buy(t, { memberId: m.id, shares: 5, method: "cash", idempotencyKey: key });
    const again = await buy(t, { memberId: m.id, shares: 5, method: "cash", idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(first.ok && again.ok && again.purchase.id).toBe(first.ok ? first.purchase.id : "");
    expect(await t.run((ctx) => shareHolding(ctx, m.id))).toMatchObject({ shares: 5 });

    await expect(buy(t, { memberId: m.id, shares: 6, method: "cash", idempotencyKey: key })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("explains what's wrong, and only sells to active members", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    expect(await buy(t, { memberId: m.id, shares: "0", method: "cheque" })).toEqual({
      ok: false,
      errors: { shares: "invalid_shares", method: "invalid_method" },
    });
    expect(await buy(t, { memberId: "00000000-0000-4000-8000-000000000000", shares: 1, method: "cash" })).toEqual({
      ok: false,
      errors: { form: "not_found" },
    });
    await t.run(({ tx }) => tx.update(member).set({ status: "exited" }).where(sql`${member.id} = ${m.id}`));
    expect(await buy(t, { memberId: m.id, shares: 1, method: "cash" })).toEqual({ ok: false, errors: { form: "member_inactive" } });
  });

  it("stops counting a purchase whose entry is reversed in the ledger", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await buy(t, { memberId: m.id, shares: 3, method: "cash" });
    const mistake = await buy(t, { memberId: m.id, shares: 30, method: "cash" });
    if (!mistake.ok) throw new Error("buy failed");
    await t.run((ctx) =>
      reverseEntry(ctx, { entryId: mistake.purchase.journalEntryId, reason: "typed 30 for 3", createdBy: t.adminUserId }),
    );
    const holding = await t.run((ctx) => shareHolding(ctx, m.id));
    expect(holding).toMatchObject({ shares: 3, amount: 300_00n });
    expect(holding.transactions.find((x) => x.shares === 30)?.reversed).toBe(true);
  });
});

describe("share records", () => {
  it("are append-only and stay within their somiti", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const other = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    const r = await buy(t, { memberId: m.id, shares: 1, method: "cash" });
    if (!r.ok) throw new Error("buy failed");
    const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });
    await expect(t.run(({ tx }) => tx.execute(sql`update share_transaction set shares = 99 where id = ${r.purchase.id}`))).rejects.toMatchObject(
      code("42501"),
    );
    await expect(t.run(({ tx }) => tx.execute(sql`delete from share_transaction where id = ${r.purchase.id}`))).rejects.toMatchObject(
      code("42501"),
    );
    expect((await other.run((ctx) => shareHolding(ctx, m.id))).transactions).toEqual([]);
    const rows = await t.run(({ tx }) => tx.select().from(shareTransaction));
    expect(rows).toHaveLength(1);
  });
});
