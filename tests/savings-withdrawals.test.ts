import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, userRole } from "../src/db/schema";
import { getEntry, reverseEntry, trialBalance } from "../src/modules/ledger";
import { admitMember } from "../src/modules/members";
import {
  approveWithdrawal,
  canApproveWithdrawals,
  canRequestWithdrawals,
  cancelWithdrawal,
  createProduct,
  deposit,
  getAccount,
  getWithdrawal,
  listWithdrawals,
  openAccount,
  rejectWithdrawal,
  requestWithdrawal,
  savingsOverview,
  withdrawalsForChecker,
  type WithdrawalInput,
} from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

async function addUser(t: TestTenant, role: "secretary" | "cashier" | "president", name = "Second Officer") {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: name, phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/** A member with a flexible account holding ৳1,000. */
async function funded(t: TestTenant, balance = "1000") {
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Saver", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!m.ok) throw new Error("admit failed");
  const p = await t.run((ctx) => createProduct(ctx, { code: "GS", nameEn: "General savings", frequency: "flexible" }, { userId: t.adminUserId }));
  if (!p.ok) throw new Error("product failed");
  const a = await t.run((ctx) => openAccount(ctx, { memberId: m.member.id, productId: p.id }, { userId: t.adminUserId }));
  if (!a.ok) throw new Error("open failed");
  const d = await t.run((ctx) =>
    deposit(ctx, { accountId: a.accountId, amount: balance, method: "cash", idempotencyKey: randomUUID() }, { userId: t.adminUserId, channel: "office" }),
  );
  if (!d.ok) throw new Error("deposit failed");
  return { memberId: m.member.id, accountId: a.accountId, depositEntryId: d.deposit.journalEntryId };
}

function ask(t: TestTenant, input: Partial<WithdrawalInput> & { accountId: string }, userId = t.adminUserId) {
  return t.run((ctx) => requestWithdrawal(ctx, { amount: "400", method: "cash", submitKey: randomUUID(), ...input }, { userId, device: "test" }));
}

async function asked(t: TestTenant, input: Partial<WithdrawalInput> & { accountId: string }, userId = t.adminUserId) {
  const r = await ask(t, input, userId);
  if (!r.ok) throw new Error(`request: ${JSON.stringify(r.errors)}`);
  return r.withdrawalId;
}

describe("withdrawal roles", () => {
  it("lets money handlers ask and managers approve", () => {
    expect(canRequestWithdrawals(["cashier"])).toBe(true);
    expect(canRequestWithdrawals(["field_collector", "member"])).toBe(false);
    expect(canApproveWithdrawals(["president"])).toBe(true);
    expect(canApproveWithdrawals(["cashier"])).toBe(false);
  });
});

describe("withdrawals", () => {
  it("post nothing until someone else approves, then Dr member savings, Cr cash", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const { memberId, accountId } = await funded(t);
    const id = await asked(t, { accountId, reason: "School fees" });

    expect((await t.run((ctx) => getAccount(ctx, accountId)))!.balance).toBe(1000_00n);
    expect(await t.run((ctx) => withdrawalsForChecker(ctx, secretary))).toBe(1);
    expect(await t.run((ctx) => withdrawalsForChecker(ctx, t.adminUserId))).toBe(0);
    expect(await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: id, userId: t.adminUserId }))).toEqual({
      ok: false,
      error: "self_decision",
    });

    const r = await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: id, userId: secretary }));
    expect(r.ok).toBe(true);
    const w = await t.run((ctx) => getWithdrawal(ctx, id));
    expect(w).toMatchObject({ status: "approved", amount: 400_00n, reason: "School fees", decidedBy: { id: secretary } });
    expect(w!.entryNo).toBe(r.ok ? r.entryNo : null);

    const view = await t.run((ctx) => getAccount(ctx, accountId));
    expect(view).toMatchObject({ balance: 600_00n, deposited: 1000_00n, deposits: 1 });
    expect(view!.transactions[0]).toMatchObject({ kind: "withdrawal", amount: 400_00n, balanceAfter: 600_00n });

    const entryId = view!.transactions[0]!.journalEntryId;
    const { entry, lines } = await t.run((ctx) => getEntry(ctx, entryId));
    expect(entry.source).toBe("savings_withdrawal");
    expect(lines.map((l) => [l.accountId, l.debit, l.credit, l.memberId])).toEqual([
      [t.accounts.member_savings, 400_00n, 0n, memberId],
      [t.accounts.cash_in_hand, 0n, 400_00n, null],
    ]);
    const tb = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(tb.rows.find((row) => row.code === "2100")?.credit).toBe(600_00n);

    // Today's deposits on the overview don't count money going out.
    const overview = await t.run((ctx) => savingsOverview(ctx));
    expect(overview).toMatchObject({ totalBalance: 600_00n, todayCount: 1, todayAmount: 1000_00n });
    expect(await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: id, userId: secretary }))).toEqual({ ok: false, error: "decided" });
  });

  it("never promises more than the balance, counting other pending requests", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const { accountId, depositEntryId } = await funded(t);
    await asked(t, { accountId, amount: "700" });
    expect(await ask(t, { accountId, amount: "400" })).toEqual({ ok: false, errors: { amount: "over_balance" }, available: 300_00n });
    const second = await asked(t, { accountId, amount: "300" });

    // The deposit turns out to be a mistake: nothing is left to pay out.
    await t.run((ctx) => reverseEntry(ctx, { entryId: depositEntryId, reason: "counterfeit notes", createdBy: t.adminUserId }));
    expect(await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: second, userId: secretary }))).toEqual({
      ok: false,
      error: "over_balance",
    });
  });

  it("can be rejected with a reason, or taken back by whoever entered it", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const { accountId } = await funded(t);
    const a = await asked(t, { accountId, amount: "100" });
    const b = await asked(t, { accountId, amount: "100" });

    expect(await t.run((ctx) => rejectWithdrawal(ctx, { withdrawalId: a, userId: secretary, note: "  " }))).toEqual({
      ok: false,
      error: "note_required",
    });
    expect(await t.run((ctx) => rejectWithdrawal(ctx, { withdrawalId: a, userId: secretary, note: "Member not present" }))).toEqual({ ok: true });
    expect(await t.run((ctx) => cancelWithdrawal(ctx, { withdrawalId: b, userId: secretary }))).toEqual({ ok: false, error: "not_maker" });
    expect(await t.run((ctx) => cancelWithdrawal(ctx, { withdrawalId: b, userId: t.adminUserId }))).toEqual({ ok: true });

    const all = await t.run((ctx) => listWithdrawals(ctx, { accountId }));
    expect(all.map((w) => w.status).sort()).toEqual(["cancelled", "rejected"]);
    expect(all.find((w) => w.id === a)).toMatchObject({ decisionNote: "Member not present", decidedBy: { id: secretary } });
    expect(await t.run((ctx) => listWithdrawals(ctx, { status: "pending" }))).toEqual([]);
    expect((await t.run((ctx) => getAccount(ctx, accountId)))!.balance).toBe(1000_00n);
  });

  it("explains what's wrong, and makes one request from a double submit", async () => {
    const t = await newTenant(DATE);
    const { accountId } = await funded(t);
    expect(await ask(t, { accountId, amount: "-5", method: "cheque" })).toEqual({
      ok: false,
      errors: { amount: "invalid_amount", method: "invalid_method" },
    });
    expect(await ask(t, { accountId, method: "mobile_wallet" })).toEqual({ ok: false, errors: { paymentRef: "ref_required" } });
    expect(await ask(t, { accountId, reason: "x".repeat(301) })).toEqual({ ok: false, errors: { reason: "reason_too_long" } });
    expect(await ask(t, { accountId: randomUUID() })).toEqual({ ok: false, errors: { form: "not_found" } });

    const submitKey = randomUUID();
    const first = await ask(t, { accountId, submitKey });
    const again = await ask(t, { accountId, submitKey });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(first.ok && again.ok && first.withdrawalId === again.withdrawalId).toBe(true);
  });

  it("keeps decisions final and stays within its somiti", async () => {
    const t = await newTenant(DATE);
    const other = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const { accountId } = await funded(t);
    const id = await asked(t, { accountId });
    await t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: id, userId: secretary }));
    const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });
    await expect(
      t.run(({ tx }) => tx.execute(sql`update savings_withdrawal set status = 'rejected', decision_note = 'x' where id = ${id}`)),
    ).rejects.toMatchObject({ code: "VOUCHER_DECIDED" });
    await expect(t.run(({ tx }) => tx.execute(sql`update savings_withdrawal set amount = 1 where id = ${id}`))).rejects.toMatchObject(
      code("42501"),
    );
    await expect(t.run(({ tx }) => tx.execute(sql`delete from savings_withdrawal where id = ${id}`))).rejects.toMatchObject(code("42501"));
    expect(await other.run((ctx) => getWithdrawal(ctx, id))).toBeNull();
    expect(await other.run((ctx) => listWithdrawals(ctx))).toEqual([]);
  });
});
