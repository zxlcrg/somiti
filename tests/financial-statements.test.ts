import { describe, expect, it } from "vitest";
import { balanceSheet, incomeStatement, postEntry, reverseEntry } from "../src/modules/ledger";
import { deposit, newTenant, type TestTenant } from "./helpers";

/** Dr cash, Cr an income account. */
const earn = (t: TestTenant, account: string, paisa: bigint, businessDate?: string) => ({
  branchId: t.branchId,
  source: "manual_voucher" as const,
  narration: "Income",
  createdBy: t.adminUserId,
  businessDate,
  lines: [
    { accountId: t.accounts.cash_in_hand, debit: paisa },
    { accountId: account, credit: paisa },
  ],
});

/** Dr an expense account, Cr cash. */
const spend = (t: TestTenant, paisa: bigint, businessDate?: string) => ({
  branchId: t.branchId,
  source: "manual_voucher" as const,
  narration: "SMS bill",
  createdBy: t.adminUserId,
  businessDate,
  lines: [
    { accountId: t.accounts.sms_expense, debit: paisa },
    { accountId: t.accounts.cash_in_hand, credit: paisa },
  ],
});

describe("income statement", () => {
  it("adds up income and expenses for the period only", async () => {
    const t = await newTenant();
    await t.run(async (ctx) => {
      await postEntry(ctx, earn(t, t.accounts.interest_income, 5_000_00n, "2026-09-10"));
      await postEntry(ctx, earn(t, t.accounts.interest_income, 2_000_00n));
      await postEntry(ctx, earn(t, t.accounts.fine_income, 50_00n));
      await postEntry(ctx, spend(t, 300_00n));
      await postEntry(ctx, deposit(t, 10_000_00n)); // savings are not income
    });
    const october = await t.run((ctx) => incomeStatement(ctx, { from: "2026-10-01", to: "2026-10-03" }));
    expect(october.income.map((l) => [l.accountId, l.amount])).toEqual([
      [t.accounts.interest_income, 2_000_00n],
      [t.accounts.fine_income, 50_00n],
    ]);
    expect(october.expenses.map((l) => [l.accountId, l.amount])).toEqual([[t.accounts.sms_expense, 300_00n]]);
    expect(october).toMatchObject({ totalIncome: 2_050_00n, totalExpenses: 300_00n, surplus: 1_750_00n });

    const year = await t.run((ctx) => incomeStatement(ctx, { from: "2026-07-01", to: "2026-10-03" }));
    expect(year.surplus).toBe(6_750_00n);
  });

  it("shows a deficit when expenses are larger, and nets out reversals", async () => {
    const t = await newTenant();
    await t.run(async (ctx) => {
      const wrong = await postEntry(ctx, earn(t, t.accounts.fee_income, 900_00n));
      await reverseEntry(ctx, { entryId: wrong.entry.id, reason: "Typed twice", createdBy: t.adminUserId });
      await postEntry(ctx, spend(t, 120_00n));
    });
    const s = await t.run((ctx) => incomeStatement(ctx, { from: "2026-10-01", to: "2026-10-03" }));
    expect(s.income).toEqual([]);
    expect(s.surplus).toBe(-120_00n);
  });
});

describe("balance sheet", () => {
  it("balances, with the year's surplus shown under equity until the year is closed", async () => {
    const t = await newTenant();
    await t.run(async (ctx) => {
      await postEntry(ctx, deposit(t, 10_000_00n));
      await postEntry(ctx, {
        branchId: t.branchId,
        source: "manual_voucher",
        narration: "Shares",
        createdBy: t.adminUserId,
        lines: [
          { accountId: t.accounts.bank, debit: 2_000_00n },
          { accountId: t.accounts.share_capital, credit: 2_000_00n },
        ],
      });
      await postEntry(ctx, earn(t, t.accounts.interest_income, 700_00n));
      await postEntry(ctx, spend(t, 200_00n));
    });
    const bs = await t.run((ctx) => balanceSheet(ctx, "2026-10-03"));
    expect(bs.assets.map((l) => [l.accountId, l.amount])).toEqual([
      [t.accounts.cash_in_hand, 10_500_00n],
      [t.accounts.bank, 2_000_00n],
    ]);
    expect(bs.liabilities.map((l) => [l.accountId, l.amount])).toEqual([[t.accounts.member_savings, 10_000_00n]]);
    expect(bs.equity.map((l) => [l.accountId, l.amount])).toEqual([[t.accounts.share_capital, 2_000_00n]]);
    expect(bs).toMatchObject({
      unclosedSurplus: 500_00n,
      totalAssets: 12_500_00n,
      totalLiabilities: 10_000_00n,
      totalEquity: 2_500_00n,
      totalClaims: 12_500_00n,
    });
  });

  it("leaves out entries after the date", async () => {
    const t = await newTenant();
    await t.run(async (ctx) => {
      await postEntry(ctx, deposit(t, 1_000_00n, { businessDate: "2026-09-01" }));
      await postEntry(ctx, deposit(t, 4_000_00n));
    });
    const bs = await t.run((ctx) => balanceSheet(ctx, "2026-09-30"));
    expect(bs.totalAssets).toBe(1_000_00n);
    expect(bs.totalClaims).toBe(1_000_00n);
    const empty = await t.run((ctx) => balanceSheet(ctx, "2026-08-01"));
    expect(empty).toMatchObject({ assets: [], liabilities: [], equity: [], totalAssets: 0n, totalClaims: 0n });
  });
});
