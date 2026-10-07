import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, auditLog, loan, loanInstallment, userRole } from "../src/db/schema";
import { addMonths } from "../src/lib/dates";
import { getEntry, trialBalance } from "../src/modules/ledger";
import { admitMember } from "../src/modules/members";
import {
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
  listLoanProducts,
  listLoans,
  loanStats,
  parsePercent,
  previewTerms,
  rejectLoan,
  setLoanProductActive,
  summarize,
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
