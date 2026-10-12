import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appUser, userRole } from "../src/db/schema";
import {
  approveCorrection,
  canApproveCorrections,
  canRequestCorrections,
  cancelCorrection,
  correctionTarget,
  listCorrections,
  rejectCorrection,
  requestCorrection,
} from "../src/modules/corrections";
import { trialBalance } from "../src/modules/ledger";
import { applyForLoan, approveLoan, createLoanProduct, disburseLoan, getLoan, listRepayments, outstanding, repayLoan, scheduleState } from "../src/modules/loans";
import { admitMember, buyShares, shareHolding } from "../src/modules/members";
import { approveWithdrawal, createProduct, deposit, getAccount, openAccount, receiveHandover, requestWithdrawal } from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

const DAY = "2026-10-12";

async function addUser(t: TestTenant, role: "secretary" | "field_collector", nameEn: string) {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn, phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

async function setup() {
  const t = await newTenant(DAY);
  const actor = { userId: t.adminUserId };
  const secretary = await addUser(t, "secretary", "Secretary");
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Saver", phone: "01711111111" }, actor));
  if (!m.ok) throw new Error("admit");
  const p = await t.run((ctx) => createProduct(ctx, { code: "GS", nameEn: "General", frequency: "flexible" }, actor));
  if (!p.ok) throw new Error("product");
  const a = await t.run((ctx) => openAccount(ctx, { memberId: m.member.id, productId: p.id }, actor));
  if (!a.ok) throw new Error("open");
  const save = async (amount: string, userId = t.adminUserId, channel: "office" | "collector" = "office") => {
    const d = await t.run((ctx) => deposit(ctx, { accountId: a.accountId, amount, method: "cash", idempotencyKey: randomUUID() }, { userId, channel }));
    if (!d.ok) throw new Error("deposit");
    return d.deposit.journalEntryId;
  };
  const ask = (entryId: string, reason = "Wrong member's passbook", userId = t.adminUserId) =>
    t.run((ctx) => requestCorrection(ctx, { entryId, reason, submitKey: randomUUID() }, { userId }));
  const approve = (correctionId: string, userId = secretary) => t.run((ctx) => approveCorrection(ctx, { correctionId, userId }));
  return { t, actor, secretary, memberId: m.member.id, accountId: a.accountId, save, ask, approve };
}

const idOf = (r: { ok: boolean }) => (r as unknown as { correctionId: string }).correctionId;

describe("correcting a member transaction", () => {
  it("lets office officers ask and managing officers approve", () => {
    expect(canRequestCorrections(["cashier"])).toBe(true);
    expect(canRequestCorrections(["field_collector"])).toBe(false);
    expect(canApproveCorrections(["secretary"])).toBe(true);
    expect(canApproveCorrections(["cashier"])).toBe(false);
  });

  it("undoes a savings deposit once a second officer approves", async () => {
    const s = await setup();
    const entryId = await s.save("500");
    expect(await s.ask(entryId, "no")).toEqual({ ok: false, error: "reason_required" });
    const asked = await s.ask(entryId);
    expect(asked).toMatchObject({ ok: true });
    expect(await s.ask(entryId)).toEqual({ ok: false, error: "already_pending" });
    expect(await s.approve(idOf(asked), s.t.adminUserId)).toEqual({ ok: false, error: "self_decision" });

    expect(await s.approve(idOf(asked))).toMatchObject({ ok: true });
    const view = await s.t.run((ctx) => getAccount(ctx, s.accountId));
    expect(view!.balance).toBe(0n);
    expect(view!.transactions[0]!.reversed).toBe(true);
    const tb = await s.t.run((ctx) => trialBalance(ctx, DAY));
    expect(tb.rows.find((r) => r.code === "2100")).toBeUndefined();
    expect(tb.rows.find((r) => r.code === "1100")).toBeUndefined();

    expect(await s.ask(entryId)).toEqual({ ok: false, error: "already_reversed" });
    const [c] = await s.t.run((ctx) => listCorrections(ctx, { entryId }));
    expect(c).toMatchObject({ status: "approved", kind: "savings_deposit", total: 500_00n, member: { id: s.memberId } });
    expect(c!.reversalNo).not.toBeNull();
  });

  it("won't take back a deposit the member has since withdrawn", async () => {
    const s = await setup();
    const entryId = await s.save("500");
    const w = await s.t.run((ctx) => requestWithdrawal(ctx, { accountId: s.accountId, amount: "300", method: "cash", submitKey: randomUUID() }, s.actor));
    if (!w.ok) throw new Error("withdraw");
    expect((await s.t.run((ctx) => correctionTarget(ctx, entryId)))!.blocker).toBe("balance_too_low");
    await s.t.run((ctx) => approveWithdrawal(ctx, { withdrawalId: w.withdrawalId, userId: s.secretary }));
    expect(await s.ask(entryId)).toEqual({ ok: false, error: "balance_too_low" });
  });

  it("won't take back a collector's deposit once the cash is handed over", async () => {
    const s = await setup();
    const collector = await addUser(s.t, "field_collector", "Rafiq");
    const entryId = await s.save("200", collector, "collector");
    expect((await s.t.run((ctx) => correctionTarget(ctx, entryId)))!.blocker).toBeNull();
    const h = await s.t.run((ctx) => receiveHandover(ctx, { collectorId: collector, amount: "200", idempotencyKey: randomUUID() }, s.actor));
    expect(h).toMatchObject({ ok: true });
    expect(await s.ask(entryId)).toEqual({ ok: false, error: "collector_handed_over" });
  });

  it("undoes a share purchase and needs a reason to reject", async () => {
    const s = await setup();
    const bought = await s.t.run((ctx) => buyShares(ctx, { memberId: s.memberId, shares: 3, method: "cash", idempotencyKey: randomUUID() }, s.actor));
    if (!bought.ok) throw new Error("shares");
    const first = await s.ask(bought.purchase.journalEntryId);
    expect(await s.t.run((ctx) => rejectCorrection(ctx, { correctionId: idOf(first), userId: s.secretary, note: " " }))).toEqual({ ok: false, error: "note_required" });
    expect(await s.t.run((ctx) => rejectCorrection(ctx, { correctionId: idOf(first), userId: s.secretary, note: "The receipt is right" }))).toEqual({ ok: true });
    expect((await s.t.run((ctx) => shareHolding(ctx, s.memberId))).shares).toBe(3);

    const second = await s.ask(bought.purchase.journalEntryId, "Counted twice");
    expect(await s.t.run((ctx) => cancelCorrection(ctx, { correctionId: idOf(second), userId: s.secretary }))).toEqual({ ok: false, error: "not_requester" });
    expect(await s.approve(idOf(second))).toMatchObject({ ok: true });
    expect((await s.t.run((ctx) => shareHolding(ctx, s.memberId))).shares).toBe(0);
  });

  it("undoes only the latest repayment of a running loan, and the schedule follows", async () => {
    const s = await setup();
    const p = await s.t.run((ctx) =>
      createLoanProduct(ctx, { code: "GL", nameEn: "General", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", guarantors: "0" }, s.actor),
    );
    if (!p.ok) throw new Error("product");
    const applied = await s.t.run((ctx) => applyForLoan(ctx, { memberId: s.memberId, productId: p.id, amount: "12,000", installments: "12", submitKey: randomUUID() }, s.actor));
    if (!applied.ok) throw new Error("apply");
    const loanId = applied.loanId;
    await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.secretary }));
    const out = await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }));
    expect(out).toMatchObject({ ok: true });
    const repay = async () => {
      const r = await s.t.run((ctx) => repayLoan(ctx, { loanId, amount: "1,120", method: "cash", idempotencyKey: randomUUID() }, { userId: s.t.adminUserId, channel: "office" }));
      if (!r.ok) throw new Error("repay");
      return r.repayment.journalEntryId;
    };
    const first = await repay();
    const second = await repay();
    expect(await s.ask(first)).toEqual({ ok: false, error: "not_latest" });

    const asked = await s.ask(second, "Paid once, entered twice");
    expect(asked).toMatchObject({ ok: true });
    expect(await s.approve(idOf(asked))).toMatchObject({ ok: true });
    const left = outstanding(await s.t.run((ctx) => scheduleState(ctx, loanId)));
    expect(left.total).toBe(13_440_00n - 1_120_00n);
    const reps = await s.t.run((ctx) => listRepayments(ctx, loanId));
    expect(reps.map((r) => r.reversed)).toEqual([true, false]);
    expect((await s.t.run((ctx) => getLoan(ctx, loanId)))!.paidPrincipal).toBe(1_000_00n);
    const tb = await s.t.run((ctx) => trialBalance(ctx, DAY));
    expect(tb.rows.find((r) => r.code === "1300")?.debit).toBe(11_000_00n);
    expect(tb.rows.find((r) => r.code === "4100")?.credit).toBe(120_00n);

    // Now the first one is the latest again.
    expect((await s.t.run((ctx) => correctionTarget(ctx, first)))!.blocker).toBeNull();
  });

  it("only knows member transactions", async () => {
    const s = await setup();
    expect(await s.ask(randomUUID())).toEqual({ ok: false, error: "not_found" });
  });
});
