import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, auditLog, savingsFine, tenant, userRole } from "../src/db/schema";
import { getEntry, reverseEntry, trialBalance } from "../src/modules/ledger";
import { admitMember } from "../src/modules/members";
import {
  approveWithdrawal,
  checkProductForm,
  collectorBoard,
  createProduct,
  deposit,
  dueStatus,
  getAccount,
  lateFineFor,
  listProducts,
  openAccount,
  requestWithdrawal,
  setLateFine,
  type DepositChannel,
  type DepositInput,
} from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

async function addUser(t: TestTenant, role: "field_collector" | "secretary", name: string) {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: name, phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/** A ৳20 daily account with a ৳5 late fine, opened on 1 October and now on the 5th: four installments are late. */
async function lateAccount() {
  const t = await newTenant("2026-10-01");
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Saver", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!m.ok) throw new Error("admit failed");
  const p = await t.run((ctx) =>
    createProduct(ctx, { code: "DS", nameEn: "Daily", frequency: "daily", installment: "20", lateFine: "5" }, { userId: t.adminUserId }),
  );
  if (!p.ok) throw new Error("product failed");
  const a = await t.run((ctx) => openAccount(ctx, { memberId: m.member.id, productId: p.id }, { userId: t.adminUserId }));
  if (!a.ok) throw new Error("open failed");
  await t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: "2026-10-05" }).where(eq(tenant.id, tenantId)));
  return { t, memberId: m.member.id, productId: p.id, accountId: a.accountId };
}

function pay(
  t: TestTenant,
  input: Omit<DepositInput, "idempotencyKey" | "method"> & { idempotencyKey?: string },
  actor: { userId?: string; channel?: DepositChannel } = {},
) {
  return t.run((ctx) =>
    deposit(ctx, { method: "cash", idempotencyKey: randomUUID(), ...input }, { userId: actor.userId ?? t.adminUserId, channel: actor.channel ?? "office" }),
  );
}

describe("late fine rule", () => {
  const rule = (paid: bigint) => ({ installment: 20_00n, lateFine: 5_00n, due: dueStatus("daily", 20_00n, "2026-10-01", "2026-10-05", paid) });

  it("charges each overdue installment a deposit starts, never the current one", () => {
    expect(rule(0n).due).toMatchObject({ behind: 100_00n, overdue: 80_00n });
    expect(lateFineFor(rule(0n), 20_00n)).toEqual({ installments: 1, fine: 5_00n });
    expect(lateFineFor(rule(0n), 50_00n)).toEqual({ installments: 3, fine: 15_00n });
    expect(lateFineFor(rule(0n), 100_00n)).toEqual({ installments: 4, fine: 20_00n });
    // ৳50 already paid: the third installment was started (and fined) then.
    expect(lateFineFor(rule(50_00n), 30_00n)).toEqual({ installments: 1, fine: 5_00n });
    expect(lateFineFor(rule(80_00n), 20_00n)).toEqual({ installments: 0, fine: 0n });
    expect(lateFineFor({ ...rule(0n), lateFine: null }, 50_00n)).toEqual({ installments: 0, fine: 0n });
  });

  it("is set per scheduled product, and never on a flexible one", async () => {
    const form = { code: "DS", nameEn: "Daily", frequency: "daily", installment: "20" };
    expect(checkProductForm({ ...form, lateFine: "৫" })).toMatchObject({ ok: true, value: { lateFine: 5_00n } });
    expect(checkProductForm({ ...form, lateFine: "" })).toMatchObject({ ok: true, value: { lateFine: null } });
    expect(checkProductForm({ ...form, lateFine: "-1" })).toEqual({ ok: false, errors: { lateFine: "invalid_amount" } });
    expect(checkProductForm({ ...form, frequency: "flexible", lateFine: "5" })).toMatchObject({ ok: true, value: { lateFine: null } });

    const { t, productId } = await lateAccount();
    const flex = await t.run((ctx) => createProduct(ctx, { code: "GS", nameEn: "General", frequency: "flexible" }, { userId: t.adminUserId }));
    if (!flex.ok) throw new Error("product failed");
    expect(await t.run((ctx) => setLateFine(ctx, flex.id, "5", { userId: t.adminUserId }))).toEqual({ ok: false, error: "flexible" });
    expect(await t.run((ctx) => setLateFine(ctx, productId, "abc", { userId: t.adminUserId }))).toEqual({ ok: false, error: "invalid_amount" });
    expect(await t.run((ctx) => setLateFine(ctx, productId, "10", { userId: t.adminUserId }))).toEqual({ ok: true });
    expect((await t.run((ctx) => listProducts(ctx))).find((p) => p.id === productId)?.lateFine).toBe(10_00n);
    expect(await t.run((ctx) => setLateFine(ctx, productId, "", { userId: t.adminUserId }))).toEqual({ ok: true });
    expect((await t.run((ctx) => listProducts(ctx))).find((p) => p.id === productId)?.lateFine).toBeNull();
  });
});

describe("late fines on deposits", () => {
  it("are collected on top of the deposit, in the same entry, to Fine income", async () => {
    const { t, memberId, accountId } = await lateAccount();
    const first = await pay(t, { accountId, amount: "50" });
    if (!first.ok) throw new Error("deposit failed");
    expect(first.deposit).toMatchObject({ amount: 50_00n, fine: 15_00n, balanceAfter: 50_00n });
    const { entry, lines } = await t.run((ctx) => getEntry(ctx, first.deposit.journalEntryId));
    expect(entry.narration).toContain("late fine for 3 installment(s)");
    expect(lines.map((l) => [l.accountId, l.debit, l.credit, l.memberId])).toEqual([
      [t.accounts.cash_in_hand, 65_00n, 0n, null],
      [t.accounts.member_savings, 0n, 50_00n, memberId],
      [t.accounts.fine_income, 0n, 15_00n, memberId],
    ]);

    // The rest of the late money: one new installment started.
    const second = await pay(t, { accountId, amount: "50" });
    expect(second.ok && second.deposit.fine).toBe(5_00n);
    // Up to date now; today's installment is never late.
    const third = await pay(t, { accountId, amount: "20" });
    expect(third.ok && third.deposit.fine).toBeNull();

    const view = await t.run((ctx) => getAccount(ctx, accountId));
    expect(view).toMatchObject({ balance: 120_00n, lateFine: 5_00n, due: { behind: -20_00n, overdue: 0n } });
    const fines = await t.run(({ tx }) => tx.select().from(savingsFine));
    expect(fines.map((f) => [f.amount, f.installments]).sort()).toEqual([
      [15_00n, 3],
      [5_00n, 1],
    ]);
    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-05"));
    expect(tb.rows.find((r) => r.accountId === t.accounts.fine_income)?.credit).toBe(20_00n);
    expect(tb.rows.find((r) => r.accountId === t.accounts.cash_in_hand)?.debit).toBe(140_00n);
  });

  it("can be waived by the cashier, which the audit log keeps", async () => {
    const { t, accountId } = await lateAccount();
    const r = await pay(t, { accountId, amount: "80", waiveFine: true });
    if (!r.ok) throw new Error("deposit failed");
    expect(r.deposit.fine).toBeNull();
    const { lines } = await t.run((ctx) => getEntry(ctx, r.deposit.journalEntryId));
    expect(lines).toHaveLength(2);
    const [log] = await t.run(({ tx }) => tx.select().from(auditLog).where(and(eq(auditLog.action, "savings.deposit"))));
    expect(log!.after).toMatchObject({ lateInstallments: 4, fine: "0", fineWaived: true });
  });

  it("post once from a repeated form, even though the first changed what is late", async () => {
    const { t, accountId } = await lateAccount();
    const key = randomUUID();
    const first = await pay(t, { accountId, amount: "40", idempotencyKey: key });
    const again = await pay(t, { accountId, amount: "40", idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, replayed: true, deposit: { fine: 10_00n } });
    expect(first.ok && again.ok && first.deposit.id === again.deposit.id).toBe(true);
    expect((await t.run((ctx) => getAccount(ctx, accountId)))!.transactions).toHaveLength(1);
  });

  it("taken on a round stay with the collector until handed over, and go when reversed", async () => {
    const { t, accountId } = await lateAccount();
    const collector = await addUser(t, "field_collector", "Rafiq");
    const r = await pay(t, { accountId, amount: "20", waiveFine: true }, { userId: collector, channel: "collector" });
    if (!r.ok) throw new Error("deposit failed");
    expect(r.deposit.fine).toBe(5_00n);
    const [c] = await t.run((ctx) => collectorBoard(ctx));
    expect(c).toMatchObject({ userId: collector, held: 25_00n, todayAmount: 25_00n });

    await t.run((ctx) => reverseEntry(ctx, { entryId: r.deposit.journalEntryId, reason: "wrong account", createdBy: t.adminUserId }));
    expect((await t.run((ctx) => collectorBoard(ctx)))[0]!.held).toBe(0n);
    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-05"));
    const fine = tb.rows.find((row) => row.accountId === t.accounts.fine_income);
    expect((fine?.credit ?? 0n) - (fine?.debit ?? 0n)).toBe(0n);
  });

  it("are append-only and stay within their somiti", async () => {
    const { t, accountId } = await lateAccount();
    const other = await newTenant();
    await pay(t, { accountId, amount: "20" });
    await expect(t.run(({ tx }) => tx.execute(sql`update savings_fine set amount = 1`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
    await expect(t.run(({ tx }) => tx.execute(sql`delete from savings_fine`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
    expect(await other.run(({ tx }) => tx.select().from(savingsFine))).toEqual([]);
  });
});

describe("product balances", () => {
  it("count withdrawals as money out", async () => {
    const { t, productId, accountId } = await lateAccount();
    const secretary = await addUser(t, "secretary", "Secretary");
    await pay(t, { accountId, amount: "100" });
    const w = await t.run((ctx) =>
      requestWithdrawal(ctx, { accountId, amount: "30", method: "cash", submitKey: randomUUID() }, { userId: t.adminUserId }),
    );
    if (!w.ok) throw new Error("withdrawal failed");
    await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: w.withdrawalId, userId: secretary }));
    expect((await t.run((ctx) => listProducts(ctx))).find((p) => p.id === productId)?.balance).toBe(70_00n);
  });
});
