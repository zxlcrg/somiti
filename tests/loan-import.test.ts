import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { tenant } from "../src/db/schema";
import { trialBalance } from "../src/modules/ledger";
import { createLoanProduct, getLoan, importLoans, loanStats, previewLoanImport, repayLoan, scheduleState } from "../src/modules/loans";
import { admitMember } from "../src/modules/members";
import { newTenant } from "./helpers";

/**
 * On 1 October: two members and a general loan product (flat 12% a year,
 * monthly, ৳50 fine). Rahim's ৳20,000 loan over 10 months was given on
 * 1 May on paper (৳2,200 a month) and ৳6,600 has been repaid: three
 * installments. Installments 4 to 10 are left; 4 (due 1 September) is already late.
 */
async function setup() {
  const t = await newTenant("2026-10-01");
  const actor = { userId: t.adminUserId };
  const admit = async (nameEn: string, phone: string) => {
    const m = await t.run((ctx) => admitMember(ctx, { nameEn, phone, admissionDate: "2026-01-01" }, actor));
    if (!m.ok) throw new Error("admit");
    return m.member;
  };
  const rahim = await admit("Rahim", "01711111111");
  const karim = await admit("Karim", "01722222222");
  const p = await t.run((ctx) =>
    createLoanProduct(
      ctx,
      { code: "GL", nameEn: "General", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", lateFine: "50" },
      actor,
    ),
  );
  if (!p.ok) throw new Error("product");
  return { t, actor, rahim, karim };
}

const header = "member_no,phone,product,disbursed_on,amount,installments,paid";

describe("importing running loans", () => {
  it("keeps only what is still owed, on the original due dates", async () => {
    const { t, rahim } = await setup();
    const csv = `${header}\n${rahim.memberNo},,gl,01/05/2026,"20,000",১০,6600\n`;
    const p = await t.run((ctx) => previewLoanImport(ctx, csv));
    expect(p.headerErrors).toEqual([]);
    expect(p.errors).toEqual([]);
    const row = p.rows[0]!;
    expect(row.remaining.map((r) => [r.seq, r.dueOn])).toEqual([
      [4, "2026-09-01"],
      [5, "2026-10-01"],
      [6, "2026-11-01"],
      [7, "2026-12-01"],
      [8, "2027-01-01"],
      [9, "2027-02-01"],
      [10, "2027-03-01"],
    ]);
    expect([row.principalLeft, row.chargeLeft, row.overdue, row.nextDue]).toEqual([14_000_00n, 1_400_00n, 1, "2026-09-01"]);
    expect(p.totals).toEqual({ loans: 1, principalLeft: 14_000_00n, chargeLeft: 1_400_00n, overdueLoans: 1 });
  });

  it("names every bad line and column", async () => {
    const { t, rahim, karim } = await setup();
    const csv = [
      header,
      `999,,GL,2026-05-01,20000,10,0`,
      `${rahim.memberNo},01722222222,GL,2026-05-01,20000,10,0`,
      `,01722222222,XX,2027-05-01,abc,0,-5`,
      `${karim.memberNo},,GL,2026-05-01,20000,10,22000`,
      `${karim.memberNo},,GL,2026-06-01,10000,5,0`,
      `${karim.memberNo},,GL,2026-07-01,10000,5,0`,
    ].join("\n");
    const p = await t.run((ctx) => previewLoanImport(ctx, csv));
    expect(p.errors).toEqual([
      { line: 2, column: "member_no", code: "unknown_member" },
      { line: 3, column: "phone", code: "member_mismatch" },
      { line: 4, column: "product", code: "unknown_product" },
      { line: 4, column: "disbursed_on", code: "date_after_business_date" },
      { line: 4, column: "amount", code: "invalid_amount" },
      { line: 4, column: "installments", code: "invalid_installments" },
      { line: 4, column: "paid", code: "invalid_paid" },
      { line: 5, column: "paid", code: "already_repaid" },
      { line: 7, column: "product", code: "duplicate_loan" },
    ]);
    expect(p.rows.map((r) => r.line)).toEqual([6]);
    expect((await t.run((ctx) => previewLoanImport(ctx, "member,amount\n1,2"))).headerErrors).toEqual([
      { code: "unknown_column", column: "member" },
      { code: "missing_column", column: "member_no" },
      { code: "missing_column", column: "product" },
      { code: "missing_column", column: "disbursed_on" },
      { code: "missing_column", column: "installments" },
      { code: "missing_column", column: "paid" },
    ]);
  });

  it("posts the principal left, once, and the loan then works like any other", async () => {
    const { t, actor, rahim } = await setup();
    const csv = `${header}\n${rahim.memberNo},,GL,2026-05-01,20000,10,6600\n`;
    const key = randomUUID();
    const r = await t.run((ctx) => importLoans(ctx, { csv, batchKey: key }, actor));
    expect(r).toEqual({ ok: true, summary: { loans: 1, principalLeft: 14_000_00n, chargeLeft: 1_400_00n, firstLoanNo: 1, lastLoanNo: 1, replayed: false } });
    expect(await t.run((ctx) => importLoans(ctx, { csv, batchKey: key }, actor))).toMatchObject({ ok: true, summary: { replayed: true } });
    // The same sheet under a new key finds the loan already open.
    expect(await t.run((ctx) => importLoans(ctx, { csv, batchKey: randomUUID() }, actor))).toMatchObject({ ok: false, error: "has_errors" });

    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-01"));
    expect(tb.rows.find((x) => x.code === "1300")?.debit).toBe(14_000_00n);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    const stats = await t.run((ctx) => loanStats(ctx));
    expect(stats.outstandingPrincipal).toBe(14_000_00n);
    // A loan given on paper months ago is not a payout of this month.
    expect(stats.monthly.reduce((sum, m) => sum + m.amount, 0n)).toBe(0n);
    const { listLoans } = await import("../src/modules/loans");
    const [l] = await t.run((ctx) => listLoans(ctx, {}));
    const detail = await t.run((ctx) => getLoan(ctx, l!.id));
    expect(detail).toMatchObject({ status: "disbursed", principal: 14_000_00n, installments: 7, disbursedOn: "2026-05-01", processingFee: 0n });
    expect(detail!.imported).toEqual({ on: "2026-10-01", originalPrincipal: 20_000_00n, originalInstallments: 10, paidBefore: 6_600_00n });

    // Paying installment 4 brings the late fine, as for any late installment.
    await t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: "2026-10-02" }).where(eq(tenant.id, tenantId)));
    const paid = await t.run((ctx) => repayLoan(ctx, { loanId: l!.id, amount: "2,200", method: "cash", idempotencyKey: randomUUID() }, { userId: actor.userId, channel: "office" }));
    expect(paid).toMatchObject({ ok: true, repayment: { principal: 2_000_00n, interest: 200_00n, fine: 50_00n } });
    const state = await t.run((ctx) => scheduleState(ctx, l!.id));
    expect(state.map((s) => [s.seq, s.paidPrincipal + s.paidInterest])).toEqual([
      [4, 2_200_00n],
      [5, 0n],
      [6, 0n],
      [7, 0n],
      [8, 0n],
      [9, 0n],
      [10, 0n],
    ]);
  });
});
