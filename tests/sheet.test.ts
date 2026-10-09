import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, savingsTransaction, tenant, userRole } from "../src/db/schema";
import { applyForLoan, approveLoan, createLoanProduct, disburseLoan } from "../src/modules/loans";
import { admitMember } from "../src/modules/members";
import { collectorBoard, createProduct, openAccount } from "../src/modules/savings";
import { collectionSheet, recordSheet } from "../src/modules/sheet";
import { newTenant, type TestTenant } from "./helpers";

async function addUser(t: TestTenant, role: "secretary" | "field_collector") {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: "Officer", phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/**
 * From 1 October: a ৳20 daily savings account with a ৳5 fine, and a ৳20,000
 * loan in ten monthly installments of ৳2,200 with a ৳50 fine. On 3 November
 * the savings is 34 days in (33 late) and the first installment is two days late.
 */
async function setup() {
  const t = await newTenant("2026-10-01");
  const admit = async (nameEn: string, phone: string) => {
    const m = await t.run((ctx) => admitMember(ctx, { nameEn, phone }, { userId: t.adminUserId }));
    if (!m.ok) throw new Error("admit");
    return m.member.id;
  };
  const saver = await admit("Saver", "01711111111");
  const borrower = await admit("Borrower", "01722222222");
  const p = await t.run((ctx) => createProduct(ctx, { code: "DS", nameEn: "Daily", frequency: "daily", installment: "20", lateFine: "5" }, { userId: t.adminUserId }));
  if (!p.ok) throw new Error("product");
  const a = await t.run((ctx) => openAccount(ctx, { memberId: saver, productId: p.id }, { userId: t.adminUserId }));
  if (!a.ok) throw new Error("open");
  const lp = await t.run((ctx) =>
    createLoanProduct(
      ctx,
      { code: "GL", nameEn: "General", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", lateFine: "50" },
      { userId: t.adminUserId },
    ),
  );
  if (!lp.ok) throw new Error("loan product");
  const secretary = await addUser(t, "secretary");
  const applied = (await t.run((ctx) =>
    applyForLoan(ctx, { memberId: borrower, productId: lp.id, amount: "20,000", installments: "10", submitKey: randomUUID() }, { userId: t.adminUserId }),
  )) as { loanId: string };
  await t.run((ctx) => approveLoan(ctx, { loanId: applied.loanId, userId: secretary }));
  await t.run((ctx) => disburseLoan(ctx, { loanId: applied.loanId, method: "cash", userId: t.adminUserId }));
  await t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: "2026-11-03" }).where(eq(tenant.id, tenantId)));
  const deposits = () =>
    t.run(({ tx, tenantId }) => tx.select().from(savingsTransaction).where(and(eq(savingsTransaction.tenantId, tenantId), eq(savingsTransaction.kind, "deposit"))));
  return { t, accountId: a.accountId, loanId: applied.loanId, deposits };
}

describe("collection sheet", () => {
  it("lists what each member owes today, with the fine paying it all would bring", async () => {
    const s = await setup();
    const sheet = await s.t.run((ctx) => collectionSheet(ctx));
    expect(sheet.date).toBe("2026-11-03");
    expect(sheet.members.map((m) => m.nameEn)).toEqual(["Saver", "Borrower"]);
    expect(sheet.members[0]!.lines).toEqual([
      { kind: "savings", id: s.accountId, no: 1, productCode: "DS", due: 680_00n, fine: 165_00n, late: true, paidToday: 0n, installment: 20_00n },
    ]);
    expect(sheet.members[1]!.lines).toEqual([
      { kind: "loan", id: s.loanId, no: 1, productCode: "GL", due: 2200_00n, fine: 50_00n, late: true, paidToday: 0n, installment: 2200_00n },
    ]);
    expect(sheet.totals).toEqual({ due: 2880_00n, fine: 215_00n, paidToday: 0n, lines: 2, members: 2 });
  });

  it("records a filled sheet once, fines on top, and ticks the lines off", async () => {
    const s = await setup();
    const entries = [
      { kind: "savings" as const, id: s.accountId, amount: "৬৮০" },
      { kind: "loan" as const, id: s.loanId, amount: "2,200" },
    ];
    const key = randomUUID();
    const r = await s.t.run((ctx) => recordSheet(ctx, entries, key, { userId: s.t.adminUserId, channel: "office" }));
    expect(r).toEqual({ ok: true, count: 2, amount: 2880_00n, fines: 215_00n });
    // The same sheet sent again posts nothing new.
    await s.t.run((ctx) => recordSheet(ctx, entries, key, { userId: s.t.adminUserId, channel: "office" }));
    expect(await s.deposits()).toHaveLength(1);

    const after = await s.t.run((ctx) => collectionSheet(ctx));
    expect(after.members.flatMap((m) => m.lines).map((l) => [l.kind, l.due, l.paidToday])).toEqual([
      ["savings", 0n, 845_00n],
      ["loan", 0n, 2250_00n],
    ]);
    expect(after.totals).toMatchObject({ due: 0n, paidToday: 3095_00n, lines: 0, members: 0 });
  });

  it("posts nothing when any line is refused, and names that line", async () => {
    const s = await setup();
    const actor = { userId: s.t.adminUserId, channel: "office" as const };
    const bad = await s.t.run((ctx) =>
      recordSheet(
        ctx,
        [
          { kind: "savings", id: s.accountId, amount: "20" },
          { kind: "loan", id: s.loanId, amount: "99,999" },
        ],
        randomUUID(),
        actor,
      ),
    );
    expect(bad).toEqual({ ok: false, errors: { [`l:${s.loanId}`]: "too_much" } });
    expect(await s.deposits()).toHaveLength(0);
    expect(await s.t.run((ctx) => recordSheet(ctx, [{ kind: "savings", id: s.accountId, amount: "abc" }], randomUUID(), actor))).toEqual({
      ok: false,
      errors: { [`s:${s.accountId}`]: "invalid_amount" },
    });
    expect(await s.t.run((ctx) => recordSheet(ctx, [{ kind: "savings", id: s.accountId, amount: " " }], randomUUID(), actor))).toEqual({
      ok: false,
      errors: {},
      form: "empty",
    });
  });

  it("puts a collector's sheet in their bag", async () => {
    const s = await setup();
    const collector = await addUser(s.t, "field_collector");
    const r = await s.t.run((ctx) =>
      recordSheet(ctx, [{ kind: "loan", id: s.loanId, amount: "2,200" }], randomUUID(), { userId: collector, channel: "collector" }),
    );
    expect(r).toMatchObject({ ok: true, amount: 2200_00n, fines: 50_00n });
    const board = await s.t.run((ctx) => collectorBoard(ctx));
    expect(board.find((c) => c.userId === collector)).toMatchObject({ held: 2250_00n, todayCount: 1 });
  });
});
