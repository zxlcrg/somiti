import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, loanGuarantor, member, userRole } from "../src/db/schema";
import {
  applyForLoan,
  approveLoan,
  cancelLoan,
  createLoanProduct,
  guarantorCandidates,
  loanGuarantors,
  memberGuarantees,
} from "../src/modules/loans";
import { admitMember, exitBlockers } from "../src/modules/members";
import { newTenant, type TestTenant } from "./helpers";

async function addSecretary(t: TestTenant) {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: "Secretary", phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role: "secretary" });
    return u!.id;
  });
}

/** A borrower, three would-be guarantors and a product that needs two guarantors. */
async function setup() {
  const t = await newTenant("2026-10-12");
  const actor = { userId: t.adminUserId };
  const admit = async (nameEn: string, phone: string) => {
    const m = await t.run((ctx) => admitMember(ctx, { nameEn, phone }, actor));
    if (!m.ok) throw new Error("admit");
    return m.member.id;
  };
  const borrower = await admit("Borrower", "01711111111");
  const [g1, g2, g3] = [await admit("Rahim", "01722222222"), await admit("Karim", "01733333333"), await admit("Salma", "01744444444")];
  const p = await t.run((ctx) =>
    createLoanProduct(
      ctx,
      { code: "GL", nameEn: "General", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", guarantors: "2" },
      actor,
    ),
  );
  if (!p.ok) throw new Error("product");
  const apply = (guarantorIds: string[], memberId = borrower) =>
    t.run((ctx) => applyForLoan(ctx, { memberId, productId: p.id, amount: "20,000", installments: "10", guarantorIds, submitKey: randomUUID() }, actor));
  return { t, actor, borrower, g1: g1!, g2: g2!, g3: g3!, apply };
}

describe("loan guarantors", () => {
  it("takes as many as the product needs, from other active members", async () => {
    const s = await setup();
    expect(await s.apply([s.g1])).toEqual({ ok: false, errors: { guarantors: "guarantors_needed" } });
    expect(await s.apply([s.g1, s.borrower])).toEqual({ ok: false, errors: { guarantors: "guarantor_self" } });
    expect(await s.apply([s.g1, s.g1])).toEqual({ ok: false, errors: { guarantors: "guarantor_duplicate" } });
    expect(await s.apply([s.g1, s.g2, s.g3, randomUUID()])).toEqual({ ok: false, errors: { guarantors: "too_many_guarantors" } });
    expect(await s.apply([s.g1, randomUUID()])).toEqual({ ok: false, errors: { guarantors: "guarantor_unknown" } });
    expect(await s.apply([s.g1, "not-an-id"])).toEqual({ ok: false, errors: { guarantors: "guarantor_unknown" } });
    await s.t.run(({ tx, tenantId }) => tx.update(member).set({ status: "exited" }).where(and(eq(member.tenantId, tenantId), eq(member.id, s.g3))));
    expect(await s.apply([s.g1, s.g3])).toEqual({ ok: false, errors: { guarantors: "guarantor_inactive" } });

    const ok = await s.apply([s.g2, s.g1]);
    expect(ok).toMatchObject({ ok: true });
    const loanId = (ok as { loanId: string }).loanId;
    const named = await s.t.run((ctx) => loanGuarantors(ctx, loanId));
    expect(named.map((g) => [g.position, g.nameEn])).toEqual([
      [1, "Karim"],
      [2, "Rahim"],
    ]);
    const candidates = await s.t.run((ctx) => guarantorCandidates(ctx, s.borrower));
    expect(candidates.map((c) => [c.nameEn, c.guarantees])).toEqual([
      ["Rahim", 1],
      ["Karim", 1],
    ]);
  });

  it("keeps a guarantor from leaving until the loan is finished", async () => {
    const s = await setup();
    const ok = await s.apply([s.g1, s.g2]);
    const loanId = (ok as { loanId: string }).loanId;
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.g1))).toEqual(["guarantor"]);
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.g3))).toEqual([]);
    expect(await s.t.run((ctx) => memberGuarantees(ctx, s.g1))).toMatchObject([{ loanNo: 1, status: "applied", outstanding: 20_000_00n, borrower: { nameEn: "Borrower" } }]);
    await s.t.run((ctx) => cancelLoan(ctx, { loanId, note: "Changed plans", userId: s.actor.userId }));
    expect(await s.t.run((ctx) => exitBlockers(ctx, s.g1))).toEqual([]);
    expect(await s.t.run((ctx) => memberGuarantees(ctx, s.g1))).toEqual([]);
  });

  it("fixes the guarantors once the loan is decided, and never the borrower", async () => {
    const s = await setup();
    const ok = await s.apply([s.g1, s.g2]);
    const loanId = (ok as { loanId: string }).loanId;
    const add = (memberId: string, position: number) =>
      s.t.run(({ tx, tenantId }) => tx.insert(loanGuarantor).values({ tenantId, loanId, memberId, position, createdBy: s.actor.userId }));
    await expect(add(s.borrower, 3)).rejects.toMatchObject({ cause: { code: "SM021" } });
    await expect(s.t.run(({ tx }) => tx.delete(loanGuarantor).where(eq(loanGuarantor.loanId, loanId)))).rejects.toThrow();
    const secretary = await addSecretary(s.t);
    expect(await s.t.run((ctx) => approveLoan(ctx, { loanId, userId: secretary }))).toMatchObject({ ok: true });
    await expect(add(s.g3, 3)).rejects.toMatchObject({ code: "VOUCHER_DECIDED" });
  });
});
