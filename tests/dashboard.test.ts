import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, auditLog, tenant, userRole } from "../src/db/schema";
import { approvalsFor, dashboardOverview, setCollectionTarget, toCollect } from "../src/modules/dashboard";
import { applyForLoan, approveLoan, createLoanProduct, disburseLoan, repayLoan } from "../src/modules/loans";
import { admitMember } from "../src/modules/members";
import { newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

async function addUser(t: TestTenant, role: "secretary" | "cashier") {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: "Second Officer", phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/** One running ৳20,000 loan (10 monthly installments of ৳2,200, first due 3 November) and one application waiting. */
async function setup() {
  const t = await newTenant(DATE);
  const admit = (nameEn: string, phone: string) =>
    t.run(async (ctx) => {
      const m = await admitMember(ctx, { nameEn, phone }, { userId: t.adminUserId });
      if (!m.ok) throw new Error("admit");
      return m.member.id;
    });
  const borrower = await admit("Borrower", "01711111111");
  const applicant = await admit("Applicant", "01722222222");
  const p = await t.run((ctx) =>
    createLoanProduct(
      ctx,
      { code: "GL", nameEn: "General loan", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", fee: "1" },
      { userId: t.adminUserId },
    ),
  );
  if (!p.ok) throw new Error("product");
  const secretary = await addUser(t, "secretary");
  const apply = (memberId: string) =>
    t.run((ctx) =>
      applyForLoan(ctx, { memberId, productId: p.id, amount: "20,000", installments: "10", submitKey: randomUUID() }, { userId: t.adminUserId }),
    ) as Promise<{ loanId: string }>;
  const { loanId } = await apply(borrower);
  await t.run((ctx) => approveLoan(ctx, { loanId, userId: secretary }));
  await t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: t.adminUserId }));
  const waiting = await apply(applicant);
  const moveTo = (d: string) => t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: d }).where(eq(tenant.id, tenantId)));
  return { t, loanId, waitingId: waiting.loanId, secretary, moveTo };
}

describe("dashboard", () => {
  it("adds up members, loans, cash and the months, and sorts the loan book by how it stands", async () => {
    const s = await setup();
    const o = await s.t.run((ctx) => dashboardOverview(ctx));
    expect(o).toMatchObject({
      today: DATE,
      members: { total: 2, active: 2, newThisMonth: 2 },
      loans: { outstanding: 20_000_00n, live: 1, waiting: 1 },
      overdue: { amount: 0n, loans: 0 },
      portfolio: { onTrack: { count: 1, amount: 20_000_00n }, dueSoon: { count: 0 }, overdue: { count: 0 } },
      target: null,
    });
    // Paid out ৳19,800 cash after the ৳200 fee.
    expect(o.cash).toMatchObject({ inHand: -19_800_00n, total: -19_800_00n });
    expect(o.months).toHaveLength(6);
    expect(o.months.at(-1)).toEqual({ month: "2026-10", savings: 0n, repayments: 0n, disbursed: 20_000_00n });
    expect(o.months[0]!.month).toBe("2026-05");

    // Two days before the first installment it is due this week.
    await s.moveTo("2026-11-01");
    expect((await s.t.run((ctx) => dashboardOverview(ctx))).portfolio).toMatchObject({ onTrack: { count: 0 }, dueSoon: { count: 1, amount: 20_000_00n } });
    expect(await s.t.run((ctx) => toCollect(ctx))).toEqual({ rows: [], total: 0, amount: 0n });

    // Two days after, it is late and on the list to collect.
    await s.moveTo("2026-11-05");
    const late = await s.t.run((ctx) => dashboardOverview(ctx));
    expect(late.overdue).toEqual({ amount: 2200_00n, loans: 1 });
    expect(late.portfolio.overdue).toEqual({ count: 1, amount: 20_000_00n });
    const due = await s.t.run((ctx) => toCollect(ctx));
    expect(due).toMatchObject({ total: 1, amount: 2200_00n });
    expect(due.rows[0]).toMatchObject({ kind: "loan", id: s.loanId, no: 1, productCode: "GL", since: "2026-11-03", late: true, paidToday: false, member: { nameEn: "Borrower" } });

    await s.t.run((ctx) => repayLoan(ctx, { loanId: s.loanId, amount: "2,200", method: "cash", idempotencyKey: randomUUID() }, { userId: s.t.adminUserId, channel: "office" }));
    const paid = await s.t.run((ctx) => dashboardOverview(ctx));
    expect(paid.taken).toEqual({ count: 1, amount: 2200_00n });
    expect(paid.months.at(-1)).toMatchObject({ month: "2026-11", repayments: 2200_00n, disbursed: 0n });
    expect(paid.portfolio.onTrack).toEqual({ count: 1, amount: 18_000_00n });
    expect(paid.loans.outstanding).toBe(18_000_00n);
    expect((await s.t.run((ctx) => toCollect(ctx))).total).toBe(0);
  });

  it("lists what waits on an officer, never their own requests", async () => {
    const s = await setup();
    const all = { loans: true, disburse: false, vouchers: true, withdrawals: true, exits: true };
    const forSecretary = await s.t.run((ctx) => approvalsFor(ctx, s.secretary, all));
    expect(forSecretary.total).toBe(1);
    expect(forSecretary.items[0]).toMatchObject({ kind: "loan", id: s.waitingId, href: `/loans/${s.waitingId}`, nameEn: "Applicant", amount: 20_000_00n });
    // The admin entered it, so it is not theirs to approve.
    expect((await s.t.run((ctx) => approvalsFor(ctx, s.t.adminUserId, all))).total).toBe(0);
    expect(await s.t.run((ctx) => approvalsFor(ctx, s.secretary, { loans: false, disburse: false, vouchers: false, withdrawals: false, exits: false }))).toEqual({ items: [], total: 0 });

    await s.t.run((ctx) => approveLoan(ctx, { loanId: s.waitingId, userId: s.secretary }));
    const toPay = await s.t.run((ctx) => approvalsFor(ctx, s.t.adminUserId, { ...all, disburse: true }));
    expect(toPay.items.map((i) => i.kind)).toEqual(["disburse"]);
  });

  it("sets the monthly collection target, and clears it when blank", async () => {
    const t = await newTenant(DATE);
    const set = (v: string) => t.run((ctx) => setCollectionTarget(ctx, v, { userId: t.adminUserId }));
    expect(await set("৫০,০০০")).toEqual({ ok: true, target: 50_000_00n });
    expect((await t.run((ctx) => dashboardOverview(ctx))).target).toBe(50_000_00n);
    expect(await set("abc")).toEqual({ ok: false, error: "invalid_amount" });
    expect(await set("0")).toEqual({ ok: false, error: "invalid_amount" });
    expect(await set("2000000000")).toEqual({ ok: false, error: "too_large" });
    expect(await set(" ")).toEqual({ ok: true, target: null });
    const audit = await t.run(({ tx, tenantId }) =>
      tx.select({ after: auditLog.after }).from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "somiti.collection_target"))),
    );
    expect(audit.map((a) => a.after)).toEqual([{ target: "5000000" }, { target: null }]);
  });
});
