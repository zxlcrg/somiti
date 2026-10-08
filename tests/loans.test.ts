import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, auditLog, loan, loanFine, loanInstallment, loanRepayment, smsOutbox, tenant, userRole } from "../src/db/schema";
import { addMonths } from "../src/lib/dates";
import { getEntry, trialBalance } from "../src/modules/ledger";
import { admitMember, exitBlockers } from "../src/modules/members";
import { collectorBoard } from "../src/modules/savings";
import {
  allocate,
  applyForLoan,
  approveLoan,
  buildSchedule,
  canApproveLoans,
  canDisburseLoans,
  cancelLoan,
  checkLoanProductForm,
  createLoanProduct,
  disburseLoan,
  getLoan,
  ageBand,
  installmentStatus,
  lateFineFor,
  listLoanProducts,
  listRepayments,
  listLoans,
  loanStats,
  overdueCount,
  overdueLoans,
  parsePercent,
  previewTerms,
  rejectLoan,
  repaymentChannel,
  repayLoan,
  setLoanProductActive,
  standing,
  summarize,
  type InstallmentState,
  type LoanProductForm,
} from "../src/modules/loans";
import { newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

describe("loan schedules", () => {
  it("rolls month ends over to the last day of shorter months", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-10-03", 12)).toBe("2027-10-03");
  });

  it("charges flat interest on the full principal, in even whole-taka installments", () => {
    const s = buildSchedule({ principal: 100_000_00n, method: "flat", rateBp: 1200, frequency: "monthly", installments: 12 }, "2026-01-31");
    expect(summarize(s)).toEqual({ installment: 9334_00n, lastInstallment: 9326_00n, totalInterest: 12_000_00n, totalRepayable: 112_000_00n });
    expect(s.map((r) => r.dueOn).slice(0, 3)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(s.at(-1)).toEqual({ seq: 12, dueOn: "2027-01-31", principal: 8326_00n, interest: 1000_00n });
  });

  it("charges declining interest on what is still owed, with equal installments", () => {
    const s = buildSchedule({ principal: 100_000_00n, method: "declining", rateBp: 1200, frequency: "monthly", installments: 12 }, DATE);
    // The textbook EMI is ৳8,884.88; the schedule rounds up to whole taka and the last one takes the rest.
    expect(summarize(s)).toMatchObject({ installment: 8885_00n, lastInstallment: 8883_46n, totalInterest: 6618_46n });
    expect(s[0]).toEqual({ seq: 1, dueOn: "2026-11-03", principal: 7885_00n, interest: 1000_00n });
    expect(s.reduce((a, r) => a + r.principal, 0n)).toBe(100_000_00n);
  });

  it("falls due weekly, and handles no interest", () => {
    const s = buildSchedule({ principal: 50_000_00n, method: "flat", rateBp: 1000, frequency: "weekly", installments: 46 }, DATE);
    expect(s.slice(0, 2).map((r) => r.dueOn)).toEqual(["2026-10-10", "2026-10-17"]);
    expect(summarize(s).totalInterest).toBe(4423_08n);
    const free = buildSchedule({ principal: 1000_00n, method: "declining", rateBp: 0, frequency: "monthly", installments: 3 }, DATE);
    expect(free.map((r) => r.principal + r.interest)).toEqual([334_00n, 334_00n, 332_00n]);
  });

  it("previews what the member receives after the fee", () => {
    expect(previewTerms({ method: "flat", rateBp: 1200, frequency: "monthly", processingFeeBp: 100 }, 20_000_00n, 10, DATE)).toMatchObject({
      processingFee: 200_00n,
      handedOver: 19_800_00n,
      totalInterest: 2000_00n,
    });
  });
});

describe("loan products", () => {
  const form: LoanProductForm = {
    code: "gl",
    nameEn: "General loan",
    method: "flat",
    rate: "১২.৫",
    frequency: "monthly",
    minAmount: "5,000",
    maxAmount: "100000",
    maxInstallments: "24",
    fee: "1",
  };

  it("reads percentages and checks limits", () => {
    expect(parsePercent("12.5%", 10_000)).toBe(1250);
    expect(parsePercent("101", 10_000)).toBeNull();
    expect(checkLoanProductForm(form)).toMatchObject({ ok: true, value: { code: "GL", rateBp: 1250, processingFeeBp: 100, minAmount: 5000_00n, maxInstallments: 24 } });
    expect(checkLoanProductForm({ ...form, method: "x", rate: "abc", maxAmount: "10", maxInstallments: "999", fee: "50" })).toEqual({
      ok: false,
      errors: { method: "invalid", rate: "invalid_rate", maxAmount: "max_below_min", maxInstallments: "invalid_installments", fee: "invalid_fee" },
    });
  });

  it("is set up once per code and can be switched off", async () => {
    const t = await newTenant(DATE);
    const r = await t.run((ctx) => createLoanProduct(ctx, form, { userId: t.adminUserId }));
    expect(r.ok).toBe(true);
    expect(await t.run((ctx) => createLoanProduct(ctx, form, { userId: t.adminUserId }))).toEqual({ ok: false, errors: { code: "code_taken" } });
    await t.run((ctx) => setLoanProductActive(ctx, (r as { id: string }).id, false, { userId: t.adminUserId }));
    expect(await t.run((ctx) => listLoanProducts(ctx, { activeOnly: true }))).toEqual([]);
  });
});

async function addUser(t: TestTenant, role: "secretary" | "cashier" | "president" | "field_collector", name = "Second Officer") {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: name, phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/** A somiti with a member, a 12%-flat monthly product with a 1% fee, and a second officer. */
async function setup() {
  const t = await newTenant(DATE);
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Borrower", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!m.ok) throw new Error("admit");
  const p = await t.run((ctx) =>
    createLoanProduct(
      ctx,
      { code: "GL", nameEn: "General loan", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", fee: "1" },
      { userId: t.adminUserId },
    ),
  );
  if (!p.ok) throw new Error("product");
  const secretary = await addUser(t, "secretary");
  return { t, memberId: m.member.id, productId: p.id, secretary };
}

function apply(s: Awaited<ReturnType<typeof setup>>, extra: Record<string, string> = {}, userId = s.t.adminUserId) {
  return s.t.run((ctx) =>
    applyForLoan(ctx, { memberId: s.memberId, productId: s.productId, amount: "20,000", installments: "10", purpose: "Rickshaw", submitKey: randomUUID(), ...extra }, { userId }),
  );
}

describe("loan applications", () => {
  it("checks the amount and term against the product", async () => {
    const s = await setup();
    expect(await apply(s, { amount: "500", installments: "30" })).toEqual({ ok: false, errors: { amount: "below_min", installments: "too_many_installments" } });
    expect(await apply(s, { amount: "abc" })).toMatchObject({ ok: false, errors: { amount: "invalid_amount" } });
  });

  it("numbers applications, makes one per submit, and one open loan per product", async () => {
    const s = await setup();
    const key = randomUUID();
    const a = await apply(s, { submitKey: key });
    expect(a).toMatchObject({ ok: true, loanNo: 1, replayed: false });
    expect(await apply(s, { submitKey: key })).toMatchObject({ ok: true, loanNo: 1, replayed: true });
    expect(await apply(s)).toEqual({ ok: false, errors: { productId: "already_open" } });
    const l = await s.t.run((ctx) => getLoan(ctx, (a as { loanId: string }).loanId));
    expect(l).toMatchObject({ status: "applied", principal: 20_000_00n, rateBp: 1200, installments: 10, processingFee: 200_00n, purpose: "Rickshaw", projected: true });
    expect(l!.schedule[0]!.dueOn).toBe("2026-11-03");
  });

  it("needs a different officer to approve or reject", async () => {
    const s = await setup();
    const a = await apply(s);
    const loanId = (a as { loanId: string }).loanId;
    expect(await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.t.adminUserId }))).toEqual({ ok: false, error: "self_decision" });
    expect(await s.t.run((ctx) => rejectLoan(ctx, { loanId, note: " ", userId: s.secretary }))).toEqual({ ok: false, error: "note_required" });
    expect(await s.t.run((ctx) => approveLoan(ctx, { loanId, meetingOn: "05/10/2026", userId: s.secretary }))).toEqual({ ok: false, error: "meeting_after_today" });
    expect(await s.t.run((ctx) => approveLoan(ctx, { loanId, meetingOn: "01/10/2026", userId: s.secretary }))).toEqual({ ok: true });
    expect(await s.t.run((ctx) => getLoan(ctx, loanId))).toMatchObject({ status: "approved", meetingOn: "2026-10-01", decidedBy: { nameEn: "Second Officer" } });
    expect(await s.t.run((ctx) => rejectLoan(ctx, { loanId, note: "late", userId: s.secretary }))).toEqual({ ok: false, error: "wrong_status" });
    // The database holds the line too.
    await expect(
      s.t.run(({ tx }) => tx.update(loan).set({ status: "applied" }).where(sql`${loan.id} = ${loanId}`)),
    ).rejects.toThrow();
  });

  it("can be withdrawn, with a reason once approved", async () => {
    const s = await setup();
    const a = (await apply(s)) as { loanId: string };
    expect(await s.t.run((ctx) => cancelLoan(ctx, { loanId: a.loanId, userId: s.t.adminUserId }))).toEqual({ ok: true });
    const b = (await apply(s)) as { loanId: string };
    await s.t.run((ctx) => approveLoan(ctx, { loanId: b.loanId, userId: s.secretary }));
    expect(await s.t.run((ctx) => cancelLoan(ctx, { loanId: b.loanId, userId: s.t.adminUserId }))).toEqual({ ok: false, error: "note_required" });
    expect(await s.t.run((ctx) => cancelLoan(ctx, { loanId: b.loanId, note: "Member changed mind", userId: s.t.adminUserId }))).toEqual({ ok: true });
    expect((await s.t.run((ctx) => listLoans(ctx, { status: "cancelled" }))).length).toBe(2);
  });

  it("is paid out by the cashier: loan receivable up, cash out less the fee, schedule written", async () => {
    const s = await setup();
    const { loanId } = (await apply(s)) as { loanId: string };
    expect(await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }))).toEqual({ ok: false, error: "wrong_status" });
    await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.secretary }));
    expect(await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "mobile_wallet", userId: s.t.adminUserId }))).toEqual({ ok: false, error: "ref_required" });
    const r = await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId, device: "test" }));
    expect(r).toMatchObject({ ok: true });

    const l = await s.t.run((ctx) => getLoan(ctx, loanId));
    expect(l).toMatchObject({ status: "disbursed", disbursedOn: DATE, paymentMethod: "cash", projected: false, entryNo: (r as { entryNo: bigint }).entryNo });
    expect(l!.schedule).toHaveLength(10);
    expect(l!.summary).toEqual({ installment: 2200_00n, lastInstallment: 2200_00n, totalInterest: 2000_00n, totalRepayable: 22_000_00n });

    const tb = await s.t.run((ctx) => trialBalance(ctx, DATE));
    const line = (id: string) => tb.rows.find((row) => row.accountId === id);
    expect(line(s.t.accounts.loans_receivable)?.debit).toBe(20_000_00n);
    expect(line(s.t.accounts.cash_in_hand)?.credit).toBe(19_800_00n);
    expect(line(s.t.accounts.fee_income)?.credit).toBe(200_00n);
    const entryId = await s.t.run(({ tx }) => tx.select({ id: loan.entryId }).from(loan).where(sql`${loan.id} = ${loanId}`));
    const { entry } = await s.t.run((ctx) => getEntry(ctx, entryId[0]!.id!));
    expect(entry).toMatchObject({ source: "loan_disbursement" });

    // Paid once only, and the schedule can't be edited.
    expect(await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }))).toEqual({ ok: false, error: "wrong_status" });
    await expect(s.t.run(({ tx }) => tx.update(loanInstallment).set({ interest: 0n }))).rejects.toThrow();

    // A running loan keeps the member from exiting.
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.memberId))).toEqual(["open_loan"]);

    const stats = await s.t.run((ctx) => loanStats(ctx));
    expect(stats).toMatchObject({ live: 1, outstandingPrincipal: 20_000_00n });
    expect(stats.monthly.at(-1)).toEqual({ month: "2026-10", amount: 20_000_00n, count: 1 });
    const logs = await s.t.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} like 'loan.%'`));
    expect(logs.map((x) => x.action).sort()).toEqual(["loan.apply", "loan.approve", "loan.disburse", "loan.product.create"]);
  });

  it("splits who does what by role", () => {
    expect(canApproveLoans(["secretary"])).toBe(true);
    expect(canApproveLoans(["cashier", "field_collector"])).toBe(false);
    expect(canDisburseLoans(["cashier"])).toBe(true);
    expect(canDisburseLoans(["admin", "secretary"])).toBe(false);
  });
});

const row = (seq: number, dueOn: string, principal: bigint, interest: bigint, paidPrincipal = 0n, paidInterest = 0n): InstallmentState => ({
  seq,
  dueOn,
  principal,
  interest,
  paidPrincipal,
  paidInterest,
});

describe("repayment allocation", () => {
  const rows = [row(1, "2026-11-03", 2000_00n, 200_00n), row(2, "2026-12-03", 2000_00n, 200_00n), row(3, "2027-01-03", 2000_00n, 200_00n)];

  it("settles the oldest installment first, in the loan's order inside each", () => {
    expect(allocate(rows, 1000_00n, "interest_first")).toEqual([{ seq: 1, interest: 200_00n, principal: 800_00n }]);
    expect(allocate(rows, 1000_00n, "principal_first")).toEqual([{ seq: 1, principal: 1000_00n, interest: 0n }]);
    // More than one installment runs on into the next ones, as an advance.
    expect(allocate(rows, 3000_00n, "interest_first")).toEqual([
      { seq: 1, interest: 200_00n, principal: 2000_00n },
      { seq: 2, interest: 200_00n, principal: 600_00n },
    ]);
    // A part-paid installment is finished before the next is touched.
    const part = [row(1, "2026-11-03", 2000_00n, 200_00n, 500_00n, 200_00n), rows[1]!];
    expect(allocate(part, 2000_00n, "interest_first")).toEqual([
      { seq: 1, interest: 0n, principal: 1500_00n },
      { seq: 2, interest: 200_00n, principal: 300_00n },
    ]);
  });

  it("refuses nothing and more than is owed", () => {
    expect(allocate(rows, 0n, "interest_first")).toBeNull();
    expect(allocate(rows, 6600_00n + 1n, "interest_first")).toBeNull();
    expect(allocate(rows, 6600_00n, "interest_first")).toHaveLength(3);
  });

  it("knows what is due, overdue and paid", () => {
    const paid = [row(1, "2026-11-03", 2000_00n, 200_00n, 2000_00n, 200_00n), row(2, "2026-12-03", 2000_00n, 200_00n, 100_00n, 200_00n), rows[2]!];
    expect(installmentStatus(paid[0]!, "2026-12-10")).toBe("paid");
    expect(installmentStatus(paid[1]!, "2026-12-10")).toBe("overdue");
    expect(installmentStatus(paid[1]!, "2026-12-03")).toBe("due");
    expect(installmentStatus(paid[1]!, "2026-11-20")).toBe("part");
    expect(installmentStatus(paid[2]!, "2026-12-10")).toBe("upcoming");
    expect(standing(paid, "2026-12-10")).toEqual({ dueNow: 1900_00n, overdueCount: 1, next: { seq: 2, dueOn: "2026-12-03", amount: 1900_00n }, paidCount: 1 });
  });
});

describe("loan repayments", () => {
  async function running() {
    const s = await setup();
    const { loanId } = (await apply(s)) as { loanId: string };
    await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.secretary }));
    await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }));
    return { ...s, loanId };
  }
  const pay = (s: Awaited<ReturnType<typeof running>>, amount: string, extra: Partial<{ method: string; paymentRef: string; key: string }> = {}, channel: "office" | "collector" = "office", userId?: string) =>
    s.t.run((ctx) =>
      repayLoan(
        ctx,
        { loanId: s.loanId, amount, method: extra.method ?? "cash", paymentRef: extra.paymentRef, idempotencyKey: extra.key ?? randomUUID() },
        { userId: userId ?? s.t.adminUserId, channel },
      ),
    );

  it("posts cash in, principal off the receivable and the charge to income", async () => {
    const s = await running();
    const r = await pay(s, "3,000");
    expect(r).toMatchObject({ ok: true, closed: false, replayed: false, repayment: { amount: 3000_00n, principal: 2600_00n, interest: 400_00n, firstSeq: 1, lastSeq: 2 } });

    const tb = await s.t.run((ctx) => trialBalance(ctx, DATE));
    const line = (id: string) => tb.rows.find((x) => x.accountId === id);
    expect(line(s.t.accounts.loans_receivable)?.debit).toBe(17_400_00n);
    expect(line(s.t.accounts.interest_income)?.credit).toBe(400_00n);
    expect(line(s.t.accounts.cash_in_hand)?.credit).toBe(16_800_00n);

    const l = (await s.t.run((ctx) => getLoan(ctx, s.loanId)))!;
    expect(l).toMatchObject({ paidPrincipal: 2600_00n, paidInterest: 400_00n, status: "disbursed" });
    expect(l.schedule[0]).toMatchObject({ paidPrincipal: 2000_00n, paidInterest: 200_00n });
    expect(l.schedule[1]).toMatchObject({ paidPrincipal: 600_00n, paidInterest: 200_00n });
    expect(await s.t.run((ctx) => loanStats(ctx))).toMatchObject({ outstandingPrincipal: 17_400_00n });
    expect((await s.t.run((ctx) => listLoanProducts(ctx)))[0]).toMatchObject({ liveLoans: 1, disbursed: 17_400_00n });

    const sms = await s.t.run(({ tx }) => tx.select().from(smsOutbox).where(sql`${smsOutbox.kind} = 'loan_repayment'`));
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain("Still owed Tk 19,000");
  });

  it("checks the form, refuses more than is owed, and posts a double submit once", async () => {
    const s = await running();
    expect(await pay(s, "0")).toEqual({ ok: false, errors: { amount: "invalid_amount" } });
    expect(await pay(s, "10", { method: "mobile_wallet" })).toEqual({ ok: false, errors: { paymentRef: "ref_required" } });
    expect(await pay(s, "22,000.01")).toEqual({ ok: false, errors: { amount: "too_much" }, owed: 22_000_00n });
    const key = randomUUID();
    const first = await pay(s, "500", { key });
    const again = await pay(s, "500", { key });
    expect(again).toMatchObject({ ok: true, replayed: true, repayment: { id: (first as { repayment: { id: string } }).repayment.id } });
    expect(await s.t.run((ctx) => listRepayments(ctx, s.loanId))).toHaveLength(1);
  });

  it("takes a collector's cash into their bag, cash only", async () => {
    const s = await running();
    const collector = await addUser(s.t, "field_collector", "Collector");
    expect(repaymentChannel(["field_collector"])).toBe("collector");
    expect(repaymentChannel(["cashier", "field_collector"])).toBe("office");
    expect(repaymentChannel(["secretary"])).toBeNull();
    expect(await pay(s, "100", { method: "bank" }, "collector", collector)).toEqual({ ok: false, errors: { method: "collector_cash_only" } });
    expect(await pay(s, "2,200", {}, "collector", collector)).toMatchObject({ ok: true });
    const tb = await s.t.run((ctx) => trialBalance(ctx, DATE));
    expect(tb.rows.find((x) => x.accountId === s.t.accounts.cash_with_collector)?.debit).toBe(2200_00n);
    const board = await s.t.run((ctx) => collectorBoard(ctx));
    expect(board.find((b) => b.userId === collector)).toMatchObject({ held: 2200_00n, todayCount: 1, todayAmount: 2200_00n });
  });

  it("closes the loan with the last taka, and then takes no more", async () => {
    const s = await running();
    await pay(s, "10,000");
    const r = await pay(s, "12,000");
    expect(r).toMatchObject({ ok: true, closed: true });
    const l = (await s.t.run((ctx) => getLoan(ctx, s.loanId)))!;
    expect(l).toMatchObject({ status: "closed", closedOn: DATE, paidPrincipal: 20_000_00n, paidInterest: 2000_00n });
    expect(await pay(s, "1")).toEqual({ ok: false, errors: { form: "not_running" } });
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.memberId))).toEqual([]);
    expect(await s.t.run((ctx) => loanStats(ctx))).toMatchObject({ live: 0, outstandingPrincipal: 0n });
    const sms = await s.t.run(({ tx }) => tx.select({ body: smsOutbox.body }).from(smsOutbox).where(sql`${smsOutbox.kind} = 'loan_repayment'`));
    expect(sms.map((x) => x.body).some((b) => b.includes("Loan fully repaid"))).toBe(true);
  });

  it("follows the product's order, and the database keeps receipts and terms fixed", async () => {
    const s = await running();
    const p = await s.t.run((ctx) =>
      createLoanProduct(
        ctx,
        { code: "PF", nameEn: "Principal first", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", allocation: "principal_first" },
        { userId: s.t.adminUserId },
      ),
    );
    expect(p.ok).toBe(true);
    const form = { code: "X", nameEn: "X", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "2000", maxInstallments: "6", allocation: "sideways" };
    expect(checkLoanProductForm(form)).toMatchObject({ ok: false, errors: { allocation: "invalid" } });
    const applied = await s.t.run((ctx) =>
      applyForLoan(ctx, { memberId: s.memberId, productId: (p as { id: string }).id, amount: "12,000", installments: "12", submitKey: randomUUID() }, { userId: s.t.adminUserId }),
    );
    const loanId = (applied as { loanId: string }).loanId;
    await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.secretary }));
    await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }));
    const r = await s.t.run((ctx) => repayLoan(ctx, { loanId, amount: "500", method: "cash", idempotencyKey: randomUUID() }, { userId: s.t.adminUserId, channel: "office" }));
    expect(r).toMatchObject({ ok: true, repayment: { principal: 500_00n, interest: 0n } });

    await expect(s.t.run(({ tx }) => tx.update(loanRepayment).set({ amount: 1n }))).rejects.toThrow();
    await expect(s.t.run(({ tx }) => tx.update(loan).set({ allocation: "interest_first" }).where(sql`${loan.id} = ${loanId}`))).rejects.toThrow();
  });
});

describe("overdue loans and late fines", () => {
  it("fines each late installment once, on the first repayment into it", () => {
    const rows = [row(1, "2026-11-03", 2000_00n, 200_00n), row(2, "2026-12-03", 2000_00n, 200_00n), row(3, "2027-01-03", 2000_00n, 200_00n)];
    const lines = allocate(rows, 5000_00n, "interest_first")!;
    expect(lateFineFor(rows, lines, "2026-12-10", 50_00n, [])).toEqual({ seqs: [1, 2], fine: 100_00n });
    expect(lateFineFor(rows, lines, "2026-12-10", 50_00n, [1])).toEqual({ seqs: [2], fine: 50_00n });
    expect(lateFineFor(rows, lines, "2026-12-03", 50_00n, [])).toEqual({ seqs: [1], fine: 50_00n });
    expect(lateFineFor(rows, lines, "2026-12-10", null, [])).toEqual({ seqs: [], fine: 0n });
    expect([1, 30, 31, 90, 91, 180, 181].map(ageBand)).toEqual(["d1_30", "d1_30", "d31_90", "d31_90", "d91_180", "d91_180", "d181"]);
  });

  it("lists late loans by age, takes the fine on top, and lets the office waive it", async () => {
    const s = await setup();
    const p = await s.t.run((ctx) =>
      createLoanProduct(
        ctx,
        { code: "LF", nameEn: "With fines", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", lateFine: "50" },
        { userId: s.t.adminUserId },
      ),
    );
    expect(checkLoanProductForm({ code: "X", nameEn: "X", method: "flat", rate: "12", frequency: "monthly", minAmount: "1", maxAmount: "2", maxInstallments: "1", lateFine: "-5" })).toMatchObject({
      ok: false,
      errors: { lateFine: "invalid_late_fine" },
    });
    const applied = await s.t.run((ctx) =>
      applyForLoan(ctx, { memberId: s.memberId, productId: (p as { id: string }).id, amount: "22,000", installments: "10", submitKey: randomUUID() }, { userId: s.t.adminUserId }),
    );
    const loanId = (applied as { loanId: string }).loanId;
    await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.secretary }));
    await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }));
    expect(await s.t.run((ctx) => overdueCount(ctx))).toBe(0);

    // Five weeks after the first due date: installments 1 and 2 are late.
    await s.t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: "2026-12-10" }).where(eq(tenant.id, tenantId)));
    const late = await s.t.run((ctx) => overdueLoans(ctx));
    expect(late.loans).toHaveLength(1);
    expect(late.loans[0]).toMatchObject({ installments: 2, amount: 4840_00n, oldestDue: "2026-11-03", daysLate: 37, band: "d31_90" });
    expect(late.byBand.d31_90).toEqual({ count: 1, amount: 4840_00n });
    expect(await s.t.run((ctx) => overdueCount(ctx))).toBe(1);

    const pay = (amount: string, extra: Partial<{ waiveFine: boolean }> = {}, channel: "office" | "collector" = "office") =>
      s.t.run((ctx) => repayLoan(ctx, { loanId, amount, method: "cash", idempotencyKey: randomUUID(), ...extra }, { userId: s.t.adminUserId, channel }));
    expect(await pay("1,000")).toMatchObject({ ok: true, repayment: { amount: 1000_00n, fine: 50_00n } });
    // The rest of installment 1 brings no second fine.
    expect(await pay("1,420")).toMatchObject({ ok: true, repayment: { fine: 0n } });
    // A collector can't waive; the office can, and that is remembered.
    expect(await pay("100", { waiveFine: true }, "collector")).toMatchObject({ ok: true, repayment: { fine: 50_00n } });
    expect(await s.t.run((ctx) => getLoan(ctx, loanId))).toMatchObject({ fined: [1, 2] });

    const tb = await s.t.run((ctx) => trialBalance(ctx, "2026-12-10"));
    expect(tb.rows.find((x) => x.accountId === s.t.accounts.fine_income)?.credit).toBe(100_00n);
    const fines = await s.t.run(({ tx }) => tx.select().from(loanFine).where(eq(loanFine.loanId, loanId)));
    expect(fines.map((f) => [f.seq, f.amount, f.waived])).toEqual([
      [1, 50_00n, false],
      [2, 50_00n, false],
    ]);
    const sms = await s.t.run(({ tx }) => tx.select({ body: smsOutbox.body }).from(smsOutbox).where(sql`${smsOutbox.kind} = 'loan_repayment'`));
    expect(sms.some((x) => x.body.includes("Late fine Tk 50"))).toBe(true);
  });

  it("records a waived fine so it is not charged again", async () => {
    const s = await setup();
    const p = await s.t.run((ctx) =>
      createLoanProduct(
        ctx,
        { code: "LF", nameEn: "With fines", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", lateFine: "50" },
        { userId: s.t.adminUserId },
      ),
    );
    const applied = await s.t.run((ctx) =>
      applyForLoan(ctx, { memberId: s.memberId, productId: (p as { id: string }).id, amount: "22,000", installments: "10", submitKey: randomUUID() }, { userId: s.t.adminUserId }),
    );
    const loanId = (applied as { loanId: string }).loanId;
    await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: s.secretary }));
    await s.t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: s.t.adminUserId }));
    await s.t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: "2026-11-20" }).where(eq(tenant.id, tenantId)));
    const pay = (amount: string, waiveFine = false) =>
      s.t.run((ctx) => repayLoan(ctx, { loanId, amount, method: "cash", idempotencyKey: randomUUID(), waiveFine }, { userId: s.t.adminUserId, channel: "office" }));
    expect(await pay("500", true)).toMatchObject({ ok: true, repayment: { fine: 0n } });
    expect(await pay("500")).toMatchObject({ ok: true, repayment: { fine: 0n } });
    const fines = await s.t.run(({ tx }) => tx.select().from(loanFine).where(eq(loanFine.loanId, loanId)));
    expect(fines.map((f) => [f.seq, f.amount, f.waived])).toEqual([[1, 0n, true]]);
    await expect(s.t.run(({ tx }) => tx.update(loanFine).set({ waived: false }))).rejects.toThrow();
    await expect(s.t.run(({ tx }) => tx.update(loan).set({ lateFine: 1n }).where(eq(loan.id, loanId)))).rejects.toThrow();
  });
});
