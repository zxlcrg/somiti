import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { member, savingsTransaction, tenant } from "../src/db/schema";
import { toBanglaDigits } from "../src/lib/digits";
import { accountIdsByKey, getEntry, reverseEntry, trialBalance } from "../src/modules/ledger";
import { admitMember } from "../src/modules/members";
import {
  canManageSavings,
  canTakeDeposits,
  checkProductForm,
  createProduct,
  deposit,
  depositChannel,
  dueStatus,
  getAccount,
  listProducts,
  memberAccounts,
  openAccount,
  periodsDue,
  savingsOverview,
  setProductActive,
  type DepositChannel,
  type DepositInput,
  type ProductForm,
} from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

async function memberOf(t: TestTenant, nameEn = "Saver") {
  const r = await t.run((ctx) => admitMember(ctx, { nameEn, phone: "01711111111" }, { userId: t.adminUserId }));
  if (!r.ok) throw new Error("admit failed");
  return r.member;
}

async function product(t: TestTenant, form: Partial<ProductForm> = {}) {
  const r = await t.run((ctx) =>
    createProduct(ctx, { code: "DS", nameEn: "Daily savings", frequency: "daily", installment: "20", ...form }, { userId: t.adminUserId }),
  );
  if (!r.ok) throw new Error(`product: ${JSON.stringify(r.errors)}`);
  return r.id;
}

async function account(t: TestTenant, form: Partial<ProductForm> = {}) {
  const m = await memberOf(t);
  const productId = await product(t, form);
  const r = await t.run((ctx) => openAccount(ctx, { memberId: m.id, productId }, { userId: t.adminUserId }));
  if (!r.ok) throw new Error(`open: ${JSON.stringify(r.errors)}`);
  return { member: m, productId, accountId: r.accountId, accountNo: r.accountNo };
}

function pay(t: TestTenant, input: Omit<DepositInput, "idempotencyKey"> & { idempotencyKey?: string }, channel: DepositChannel = "office") {
  return t.run((ctx) => deposit(ctx, { idempotencyKey: randomUUID(), ...input }, { userId: t.adminUserId, channel, device: "test" }));
}

describe("who does what", () => {
  it("lets managers set up savings, and cashiers or collectors take deposits", () => {
    expect(canManageSavings(["secretary"])).toBe(true);
    expect(canManageSavings(["cashier", "field_collector"])).toBe(false);
    expect(canTakeDeposits(["cashier"])).toBe(true);
    expect(canTakeDeposits(["field_collector"])).toBe(true);
    expect(canTakeDeposits(["admin", "president", "secretary"])).toBe(false);
    expect(depositChannel(["field_collector"])).toBe("collector");
    expect(depositChannel(["field_collector", "cashier"])).toBe("office");
    expect(depositChannel(["admin"])).toBeNull();
  });
});

describe("schedules", () => {
  it("counts installments due, the current period included", () => {
    expect(periodsDue("daily", "2026-10-01", "2026-10-01")).toBe(1);
    expect(periodsDue("daily", "2026-10-01", "2026-10-07")).toBe(7);
    expect(periodsDue("weekly", "2026-10-01", "2026-10-07")).toBe(1);
    expect(periodsDue("weekly", "2026-10-01", "2026-10-08")).toBe(2);
    expect(periodsDue("monthly", "2026-10-31", "2026-11-01")).toBe(2);
    expect(periodsDue("monthly", "2026-07-15", "2027-06-30")).toBe(12);
    expect(periodsDue("flexible", "2026-07-15", "2027-06-30")).toBe(0);
    expect(periodsDue("daily", "2026-10-05", "2026-10-01")).toBe(0);
  });

  it("says how far behind or ahead an account is", () => {
    expect(dueStatus("daily", 20_00n, "2026-10-01", "2026-10-05", 60_00n)).toEqual({ periods: 5, expected: 100_00n, paid: 60_00n, behind: 40_00n, overdue: 20_00n });
    expect(dueStatus("monthly", 500_00n, "2026-10-01", "2026-10-05", 1000_00n)?.behind).toBe(-500_00n);
    expect(dueStatus("flexible", null, "2026-10-01", "2026-10-05", 0n)).toBeNull();
  });
});

describe("savings products", () => {
  it("checks the form, in either script", () => {
    expect(checkProductForm({ code: " dps-1 ", nameEn: "Monthly DPS", frequency: "monthly", installment: toBanglaDigits("৫০০") })).toMatchObject({
      ok: true,
      value: { code: "DPS-1", frequency: "monthly", installment: 500_00n, minDeposit: 1_00n },
    });
    expect(checkProductForm({ code: "", nameEn: "", frequency: "yearly" })).toEqual({
      ok: false,
      errors: { code: "required", nameEn: "required", frequency: "invalid_frequency" },
    });
    expect(checkProductForm({ code: "A B", nameEn: "X", frequency: "daily", installment: "-5" }).ok).toBe(false);
    expect(checkProductForm({ code: "GS", nameEn: "General", frequency: "flexible", installment: "50" })).toMatchObject({
      ok: true,
      value: { installment: null },
    });
    expect(checkProductForm({ code: "D", nameEn: "D", frequency: "daily" })).toEqual({ ok: false, errors: { installment: "required" } });
  });

  it("keeps codes unique per somiti, and lists open accounts and balances", async () => {
    const t = await newTenant(DATE);
    const { accountId } = await account(t);
    expect(await t.run((ctx) => createProduct(ctx, { code: "ds", nameEn: "Again", frequency: "flexible" }, { userId: t.adminUserId }))).toEqual({
      ok: false,
      errors: { code: "code_taken" },
    });
    await pay(t, { accountId, amount: "40", method: "cash" });
    const [p] = await t.run((ctx) => listProducts(ctx));
    expect(p).toMatchObject({ code: "DS", installment: 20_00n, openAccounts: 1, balance: 40_00n, active: true });
  });

  it("stops new accounts on a product that is switched off", async () => {
    const t = await newTenant(DATE);
    const m = await memberOf(t);
    const productId = await product(t);
    await t.run((ctx) => setProductActive(ctx, productId, false, { userId: t.adminUserId }));
    expect(await t.run((ctx) => openAccount(ctx, { memberId: m.id, productId }, { userId: t.adminUserId }))).toEqual({
      ok: false,
      errors: { productId: "product_inactive" },
    });
    expect(await t.run((ctx) => listProducts(ctx, { activeOnly: true }))).toEqual([]);
  });
});

describe("savings accounts", () => {
  it("numbers accounts in order and allows one open account per product", async () => {
    const t = await newTenant(DATE);
    const first = await account(t);
    expect(first.accountNo).toBe(1);
    expect(await t.run((ctx) => openAccount(ctx, { memberId: first.member.id, productId: first.productId }, { userId: t.adminUserId }))).toEqual({
      ok: false,
      errors: { productId: "already_open" },
    });
    const other = await memberOf(t, "Second saver");
    const second = await t.run((ctx) => openAccount(ctx, { memberId: other.id, productId: first.productId, installment: "50" }, { userId: t.adminUserId }));
    expect(second).toMatchObject({ ok: true, accountNo: 2 });
    const [a] = await t.run((ctx) => memberAccounts(ctx, other.id));
    expect(a).toMatchObject({ installment: 50_00n, openedOn: DATE, balance: 0n, due: { periods: 1, behind: 50_00n } });
  });

  it("opens only for active members", async () => {
    const t = await newTenant(DATE);
    const m = await memberOf(t);
    const productId = await product(t);
    await t.run(({ tx }) => tx.update(member).set({ status: "exited" }).where(sql`${member.id} = ${m.id}`));
    expect(await t.run((ctx) => openAccount(ctx, { memberId: m.id, productId }, { userId: t.adminUserId }))).toEqual({
      ok: false,
      errors: { form: "member_inactive" },
    });
  });
});

describe("deposits", () => {
  it("posts Dr cash, Cr member savings on the member's line, and shows on the passbook", async () => {
    const t = await newTenant(DATE);
    const { member: m, accountId } = await account(t);
    const r = await pay(t, { accountId, amount: toBanglaDigits("1,250.50"), method: "cash" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deposit).toMatchObject({ amount: 1250_50n, channel: "office", paymentMethod: "cash", reversed: false, balanceAfter: 1250_50n });

    const { entry, lines } = await t.run((ctx) => getEntry(ctx, r.deposit.journalEntryId));
    expect(entry.source).toBe("savings_deposit");
    expect(lines.map((l) => [l.accountId, l.debit, l.credit, l.memberId])).toEqual([
      [t.accounts.cash_in_hand, 1250_50n, 0n, null],
      [t.accounts.member_savings, 0n, 1250_50n, m.id],
    ]);
    const tb = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(tb.rows.find((row) => row.code === "2100")?.credit).toBe(1250_50n);

    await pay(t, { accountId, amount: "100", method: "bank", paymentRef: "SLIP-1" });
    const view = await t.run((ctx) => getAccount(ctx, accountId));
    expect(view).toMatchObject({ balance: 1350_50n, deposits: 2, lastDepositOn: DATE });
    expect(view!.transactions.map((x) => x.balanceAfter)).toEqual([1350_50n, 1250_50n]);
    expect(view!.transactions[0]!.takenBy.nameEn).toBe("Admin");
  });

  it("puts a collector's cash in Cash with collector, and takes only cash from them", async () => {
    const t = await newTenant(DATE);
    const { accountId } = await account(t);
    const r = await pay(t, { accountId, amount: "20", method: "cash" }, "collector");
    if (!r.ok) throw new Error("deposit failed");
    const { lines } = await t.run((ctx) => getEntry(ctx, r.deposit.journalEntryId));
    const keys = await t.run((ctx) => accountIdsByKey(ctx, ["cash_with_collector"] as const));
    expect(lines[0]).toMatchObject({ accountId: keys.cash_with_collector, debit: 20_00n });
    expect(await pay(t, { accountId, amount: "20", method: "bank" }, "collector")).toEqual({
      ok: false,
      errors: { method: "collector_cash_only" },
    });
  });

  it("explains what's wrong", async () => {
    const t = await newTenant(DATE);
    const { member: m, accountId } = await account(t, { minDeposit: "10" });
    expect(await pay(t, { accountId, amount: "abc", method: "cheque" })).toEqual({
      ok: false,
      errors: { amount: "invalid_amount", method: "invalid_method" },
    });
    expect(await pay(t, { accountId, amount: "5", method: "cash" })).toEqual({ ok: false, errors: { amount: "below_minimum" } });
    expect(await pay(t, { accountId, amount: "50", method: "mobile_wallet" })).toEqual({ ok: false, errors: { paymentRef: "ref_required" } });
    expect(await pay(t, { accountId, amount: "20000000", method: "cash" })).toEqual({ ok: false, errors: { amount: "too_large" } });
    expect(await pay(t, { accountId: randomUUID(), amount: "50", method: "cash" })).toEqual({ ok: false, errors: { form: "not_found" } });
    await t.run(({ tx }) => tx.update(member).set({ status: "exited" }).where(sql`${member.id} = ${m.id}`));
    expect(await pay(t, { accountId, amount: "50", method: "cash" })).toEqual({ ok: false, errors: { form: "member_inactive" } });
  });

  it("posts once when the same form is sent twice", async () => {
    const t = await newTenant(DATE);
    const { accountId } = await account(t);
    const key = randomUUID();
    const first = await pay(t, { accountId, amount: "20", method: "cash", idempotencyKey: key });
    const again = await pay(t, { accountId, amount: "20", method: "cash", idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(first.ok && again.ok && again.deposit.id === first.deposit.id).toBe(true);
    expect((await t.run((ctx) => getAccount(ctx, accountId)))!.balance).toBe(20_00n);
  });

  it("stops counting a deposit whose entry is reversed, and tracks dues", async () => {
    const t = await newTenant("2026-10-05");
    const { accountId } = await account(t);
    // Opened today: one ৳20 installment due.
    await pay(t, { accountId, amount: "20", method: "cash" });
    const mistake = await pay(t, { accountId, amount: "2000", method: "cash" });
    if (!mistake.ok) throw new Error("deposit failed");
    await t.run((ctx) => reverseEntry(ctx, { entryId: mistake.deposit.journalEntryId, reason: "typed 2000 for 20", createdBy: t.adminUserId }));
    const view = await t.run((ctx) => getAccount(ctx, accountId));
    expect(view).toMatchObject({ balance: 20_00n, deposits: 1, due: { periods: 1, behind: 0n } });
    expect(view!.transactions[0]).toMatchObject({ reversed: true, balanceAfter: 20_00n });

    // Two days later two more installments are due.
    await t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: "2026-10-07" }).where(sql`${tenant.id} = ${tenantId}`));
    const overview = await t.run((ctx) => savingsOverview(ctx));
    expect(overview).toMatchObject({ totalBalance: 20_00n, openAccounts: 1, todayCount: 0 });
    expect(overview.behind).toEqual([expect.objectContaining({ accountId, behind: 40_00n, nameEn: "Saver" })]);
    expect(overview.daily).toHaveLength(14);
    expect(overview.daily.find((d) => d.date === "2026-10-05")).toEqual({ date: "2026-10-05", amount: 20_00n, count: 1 });
  });
});

describe("savings records", () => {
  it("are append-only and stay within their somiti", async () => {
    const t = await newTenant(DATE);
    const other = await newTenant(DATE);
    const { accountId } = await account(t);
    const r = await pay(t, { accountId, amount: "20", method: "cash" });
    if (!r.ok) throw new Error("deposit failed");
    const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });
    await expect(t.run(({ tx }) => tx.execute(sql`update savings_transaction set amount = 1 where id = ${r.deposit.id}`))).rejects.toMatchObject(
      code("42501"),
    );
    await expect(t.run(({ tx }) => tx.execute(sql`delete from savings_account where id = ${accountId}`))).rejects.toMatchObject(code("42501"));
    await expect(t.run(({ tx }) => tx.execute(sql`update savings_product set frequency = 'weekly'`))).rejects.toMatchObject(code("42501"));
    expect(await other.run((ctx) => getAccount(ctx, accountId))).toBeNull();
    expect(await t.run(({ tx }) => tx.select().from(savingsTransaction))).toHaveLength(1);
  });
});
