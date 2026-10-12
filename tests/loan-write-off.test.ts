import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appUser, userRole } from "../src/db/schema";
import { trialBalance } from "../src/modules/ledger";
import {
  applyForLoan,
  approveLoan,
  approveWriteOff,
  cancelWriteOff,
  createLoanProduct,
  disburseLoan,
  getLoan,
  loanStats,
  loanWriteOffs,
  overdueLoans,
  rejectWriteOff,
  repayLoan,
  requestWriteOff,
} from "../src/modules/loans";
import { admitMember, exitBlockers } from "../src/modules/members";
import { newTenant } from "./helpers";

/** A ৳12,000 loan over 12 months at 12% flat (৳1,120 a month), one installment repaid. */
async function setup() {
  const t = await newTenant("2026-10-12");
  const actor = { userId: t.adminUserId };
  const secretary = await t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: "Secretary", phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role: "secretary" });
    return u!.id;
  });
  const admit = async (nameEn: string, phone: string) => {
    const m = await t.run((ctx) => admitMember(ctx, { nameEn, phone }, actor));
    if (!m.ok) throw new Error("admit");
    return m.member.id;
  };
  const borrower = await admit("Borrower", "01711111111");
  const guarantor = await admit("Guarantor", "01722222222");
  const p = await t.run((ctx) =>
    createLoanProduct(
      ctx,
      { code: "GL", nameEn: "General", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", guarantors: "1" },
      actor,
    ),
  );
  if (!p.ok) throw new Error("product");
  const applied = await t.run((ctx) =>
    applyForLoan(ctx, { memberId: borrower, productId: p.id, amount: "12,000", installments: "12", guarantorIds: [guarantor], submitKey: randomUUID() }, actor),
  );
  if (!applied.ok) throw new Error("apply");
  const loanId = applied.loanId;
  await t.run((ctx) => approveLoan(ctx, { loanId, userId: secretary }));
  await t.run((ctx) => disburseLoan(ctx, { loanId, method: "cash", userId: t.adminUserId }));
  const paid = await t.run((ctx) => repayLoan(ctx, { loanId, amount: "1,120", method: "cash", idempotencyKey: randomUUID() }, { userId: t.adminUserId, channel: "office" }));
  if (!paid.ok) throw new Error("repay");
  const ask = (reason = "Moved away, can't be reached", userId = t.adminUserId) => t.run((ctx) => requestWriteOff(ctx, { loanId, reason, submitKey: randomUUID() }, { userId }));
  return { t, actor, secretary, borrower, guarantor, loanId, ask };
}

describe("writing off a loan", () => {
  it("takes a second officer, then moves the principal still owed to bad debts", async () => {
    const s = await setup();
    expect(await s.ask("no")).toEqual({ ok: false, error: "reason_required" });
    const asked = await s.ask();
    expect(asked).toMatchObject({ ok: true });
    const writeOffId = (asked as { writeOffId: string }).writeOffId;
    expect(await s.ask()).toEqual({ ok: false, error: "already_pending" });
    expect(await s.t.run((ctx) => approveWriteOff(ctx, { writeOffId, userId: s.t.adminUserId }))).toEqual({ ok: false, error: "self_decision" });

    const done = await s.t.run((ctx) => approveWriteOff(ctx, { writeOffId, userId: s.secretary, note: "Committee agreed" }));
    expect(done).toMatchObject({ ok: true, principal: 11_000_00n, charge: 1_320_00n });

    const tb = await s.t.run((ctx) => trialBalance(ctx, "2026-10-12"));
    expect(tb.rows.find((r) => r.code === "1300")).toBeUndefined();
    expect(tb.rows.find((r) => r.code === "5700")?.debit).toBe(11_000_00n);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    expect(await s.t.run((ctx) => getLoan(ctx, s.loanId))).toMatchObject({ status: "written_off" });
    expect((await s.t.run((ctx) => loanStats(ctx))).outstandingPrincipal).toBe(0n);
    expect((await s.t.run((ctx) => overdueLoans(ctx))).loans).toEqual([]);
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.guarantor))).toEqual([]);
    expect(
      await s.t.run((ctx) => repayLoan(ctx, { loanId: s.loanId, amount: "100", method: "cash", idempotencyKey: randomUUID() }, { userId: s.t.adminUserId, channel: "office" })),
    ).toMatchObject({ ok: false, errors: { form: "not_running" } });
    expect(await s.ask()).toEqual({ ok: false, error: "not_running" });
    expect(await s.t.run((ctx) => loanWriteOffs(ctx, s.loanId))).toMatchObject([
      { status: "approved", principal: 11_000_00n, charge: 1_320_00n, writtenOn: "2026-10-12", decisionNote: "Committee agreed", decidedBy: { nameEn: "Secretary" } },
    ]);
  });

  it("can be withdrawn by the officer who asked, or turned down by another", async () => {
    const s = await setup();
    const first = (await s.ask()) as { writeOffId: string };
    expect(await s.t.run((ctx) => cancelWriteOff(ctx, { writeOffId: first.writeOffId, userId: s.secretary }))).toEqual({ ok: false, error: "not_requester" });
    expect(await s.t.run((ctx) => cancelWriteOff(ctx, { writeOffId: first.writeOffId, userId: s.t.adminUserId }))).toEqual({ ok: true });
    expect(await s.t.run((ctx) => approveWriteOff(ctx, { writeOffId: first.writeOffId, userId: s.secretary }))).toEqual({ ok: false, error: "wrong_status" });

    const second = (await s.ask()) as { writeOffId: string };
    expect(await s.t.run((ctx) => rejectWriteOff(ctx, { writeOffId: second.writeOffId, note: " ", userId: s.secretary }))).toEqual({ ok: false, error: "note_required" });
    expect(await s.t.run((ctx) => rejectWriteOff(ctx, { writeOffId: second.writeOffId, note: "He is paying again", userId: s.secretary }))).toEqual({ ok: true });
    expect(await s.t.run((ctx) => getLoan(ctx, s.loanId))).toMatchObject({ status: "disbursed" });
    expect((await s.t.run((ctx) => loanWriteOffs(ctx, s.loanId))).map((w) => w.status)).toEqual(["rejected", "cancelled"]);
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.guarantor))).toEqual(["guarantor"]);
  });
});
