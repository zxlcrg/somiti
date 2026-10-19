import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appUser, userRole } from "../src/db/schema";
import { approveCorrection, requestCorrection } from "../src/modules/corrections";
import { postEntry } from "../src/modules/ledger";
import { applyForLoan, approveLoan, createLoanProduct, disburseLoan, repayLoan } from "../src/modules/loans";
import { admitMember, buyShares } from "../src/modules/members";
import { booksCheck, memberStatement } from "../src/modules/reports";
import { createProduct, deposit, openAccount, receiveHandover } from "../src/modules/savings";
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

/** One member with savings, shares, a loan with a repayment, and a collector's deposit partly handed over. */
async function busySomiti() {
  const t = await newTenant(DAY);
  const actor = { userId: t.adminUserId };
  const secretary = await addUser(t, "secretary", "Secretary");
  const collector = await addUser(t, "field_collector", "Rafiq");
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Saver", phone: "01711111111" }, actor));
  if (!m.ok) throw new Error("admit");
  const memberId = m.member.id;
  const p = await t.run((ctx) => createProduct(ctx, { code: "GS", nameEn: "General", frequency: "flexible" }, actor));
  if (!p.ok) throw new Error("product");
  const a = await t.run((ctx) => openAccount(ctx, { memberId, productId: p.id }, actor));
  if (!a.ok) throw new Error("open");
  const save = async (amount: string, userId = t.adminUserId, channel: "office" | "collector" = "office") => {
    const d = await t.run((ctx) => deposit(ctx, { accountId: a.accountId, amount, method: "cash", idempotencyKey: randomUUID() }, { userId, channel }));
    if (!d.ok) throw new Error("deposit");
    return d.deposit.journalEntryId;
  };
  await save("1,000");
  const mistake = await save("250");
  await save("400", collector, "collector");
  await t.run((ctx) => receiveHandover(ctx, { collectorId: collector, amount: "300", idempotencyKey: randomUUID() }, actor));
  const shares = await t.run((ctx) => buyShares(ctx, { memberId, shares: 2, method: "cash", idempotencyKey: randomUUID() }, actor));
  if (!shares.ok) throw new Error("shares");

  const lp = await t.run((ctx) =>
    createLoanProduct(ctx, { code: "GL", nameEn: "General", method: "flat", rate: "12", frequency: "monthly", minAmount: "1000", maxAmount: "100000", maxInstallments: "24", guarantors: "0" }, actor),
  );
  if (!lp.ok) throw new Error("loan product");
  const applied = await t.run((ctx) => applyForLoan(ctx, { memberId, productId: lp.id, amount: "12,000", installments: "12", submitKey: randomUUID() }, actor));
  if (!applied.ok) throw new Error("apply");
  await t.run((ctx) => approveLoan(ctx, { loanId: applied.loanId, userId: secretary }));
  await t.run((ctx) => disburseLoan(ctx, { loanId: applied.loanId, method: "cash", userId: t.adminUserId }));
  const r = await t.run((ctx) => repayLoan(ctx, { loanId: applied.loanId, amount: "1,120", method: "cash", idempotencyKey: randomUUID() }, { userId: t.adminUserId, channel: "office" }));
  if (!r.ok) throw new Error("repay");

  // The 250 deposit was a mistake and is undone through a correction.
  const asked = await t.run((ctx) => requestCorrection(ctx, { entryId: mistake, reason: "Entered twice", submitKey: randomUUID() }, actor));
  if (!asked.ok) throw new Error("ask");
  await t.run((ctx) => approveCorrection(ctx, { correctionId: (asked as unknown as { correctionId: string }).correctionId, userId: secretary }));
  return { t, memberId, actor };
}

describe("books check", () => {
  it("finds member records and the ledger in agreement", async () => {
    const { t } = await busySomiti();
    const check = await t.run((ctx) => booksCheck(ctx));
    const by = Object.fromEntries(check.checks.map((c) => [c.key, c]));
    expect(by.savings).toMatchObject({ code: "2100", books: 1_400_00n, records: 1_400_00n, members: [] });
    expect(by.shares!.books).toBe(by.shares!.records);
    expect(by.shares!.books).toBeGreaterThan(0n);
    expect(by.loans).toMatchObject({ code: "1300", books: 11_000_00n, records: 11_000_00n });
    expect(by.collectorCash).toMatchObject({ code: "1110", books: 100_00n, records: 100_00n });
    expect(check.ok).toBe(true);
  });

  it("names the member whose ledger lines don't match their records", async () => {
    const { t, memberId } = await busySomiti();
    // A posting straight to the ledger, with no savings record behind it.
    await t.run((ctx) =>
      postEntry(ctx, {
        branchId: t.branchId,
        source: "system",
        narration: "Stray posting",
        createdBy: t.adminUserId,
        lines: [
          { accountId: t.accounts.cash_in_hand, debit: 50_00n },
          { accountId: t.accounts.member_savings, credit: 50_00n, memberId },
        ],
      }),
    );
    const check = await t.run((ctx) => booksCheck(ctx));
    const savings = check.checks.find((c) => c.key === "savings")!;
    expect(check.ok).toBe(false);
    expect(savings.books - savings.records).toBe(50_00n);
    expect(savings.members).toMatchObject([{ memberId, books: 1_450_00n, records: 1_400_00n }]);
  });
});

describe("member statement", () => {
  it("lists every movement with running balances and leaves out what was undone", async () => {
    const { t, memberId } = await busySomiti();
    const s = await t.run((ctx) => memberStatement(ctx, { memberId, from: DAY, to: DAY }));
    expect(s.opening).toEqual({ savings: 0n, shares: 0n, loan: 0n });
    expect(s.closing.savings).toBe(1_400_00n);
    expect(s.closing.loan).toBe(11_000_00n);
    expect(s.rows.map((r) => r.kind)).toEqual([
      "savings_deposit",
      "savings_deposit",
      "savings_deposit",
      "share_purchase",
      "loan_disbursement",
      "loan_repayment",
    ]);
    expect(s.rows[1]).toMatchObject({ reversed: true, savings: 250_00n, savingsAfter: 1_000_00n });
    expect(s.rows[5]).toMatchObject({ loan: -1_000_00n, charge: 120_00n, paidIn: 1_120_00n, loanAfter: 11_000_00n });
    expect(s.totals.paidOut).toBe(12_000_00n);
    expect(s.totals.charge).toBe(120_00n);
  });

  it("carries earlier movements into the opening balance", async () => {
    const { t, memberId } = await busySomiti();
    const s = await t.run((ctx) => memberStatement(ctx, { memberId, from: "2026-10-13", to: "2026-10-31" }));
    expect(s.rows).toEqual([]);
    expect(s.opening).toEqual(s.closing);
    expect(s.opening.loan).toBe(11_000_00n);
  });
});
