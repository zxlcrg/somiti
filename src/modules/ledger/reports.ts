import { and, asc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { journalEntry, journalLine, ledgerAccount } from "@/db/schema";

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  nameEn: string | null;
  nameBn: string | null;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  /** Net balance on the debit side (0 when the account is in credit). */
  debit: bigint;
  /** Net balance on the credit side (0 when the account is in debit). */
  credit: bigint;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: bigint;
  totalCredit: bigint;
}

/**
 * Trial balance as of a business date, computed from journal lines. Account
 * balances are never stored, so there is no running-balance row to lock.
 */
export async function trialBalance(ctx: TenantTx, asOf: string): Promise<TrialBalance> {
  const sums = ctx.tx
    .select({
      accountId: journalLine.accountId,
      debit: sql<string>`sum(${journalLine.debit})`.as("debit"),
      credit: sql<string>`sum(${journalLine.credit})`.as("credit"),
    })
    .from(journalLine)
    .innerJoin(
      journalEntry,
      and(eq(journalEntry.tenantId, journalLine.tenantId), eq(journalEntry.id, journalLine.entryId)),
    )
    .where(and(eq(journalLine.tenantId, ctx.tenantId), lte(journalEntry.businessDate, asOf)))
    .groupBy(journalLine.accountId)
    .as("sums");

  const rows = await ctx.tx
    .select({
      accountId: ledgerAccount.id,
      code: ledgerAccount.code,
      nameEn: ledgerAccount.nameEn,
      nameBn: ledgerAccount.nameBn,
      type: ledgerAccount.type,
      debit: sums.debit,
      credit: sums.credit,
    })
    .from(ledgerAccount)
    .innerJoin(sums, eq(sums.accountId, ledgerAccount.id))
    .where(eq(ledgerAccount.tenantId, ctx.tenantId))
    .orderBy(asc(ledgerAccount.code));

  let totalDebit = 0n;
  let totalCredit = 0n;
  const result: TrialBalanceRow[] = [];
  for (const r of rows) {
    const net = BigInt(r.debit) - BigInt(r.credit);
    if (net === 0n) continue;
    const row = { ...r, debit: net > 0n ? net : 0n, credit: net < 0n ? -net : 0n };
    totalDebit += row.debit;
    totalCredit += row.credit;
    result.push(row);
  }
  return { asOf, rows: result, totalDebit, totalCredit };
}

export interface CashBookRow {
  entryId: string;
  entryNo: bigint;
  businessDate: string;
  source: (typeof journalEntry.$inferSelect)["source"];
  narration: string;
  /** The other accounts in the entry: where the money came from or went to. */
  contra: Array<{ code: string; nameEn: string | null; nameBn: string | null }>;
  receipt: bigint;
  payment: bigint;
  balance: bigint;
}

export interface CashBook {
  accountId: string;
  from: string;
  to: string;
  opening: bigint;
  receipts: bigint;
  payments: bigint;
  closing: bigint;
  rows: CashBookRow[];
}

/** Accounts a cash book can be kept for. */
export const CASH_BOOK_KEYS = ["cash_in_hand", "cash_with_collector", "bank", "mobile_wallet"] as const;

/**
 * Cash book for one cash or bank account between two business dates
 * (inclusive): the opening balance, every receipt and payment with a
 * running balance, and the closing balance.
 */
export async function cashBook(ctx: TenantTx, q: { accountId: string; from: string; to: string }): Promise<CashBook> {
  const onAccount = and(eq(journalLine.tenantId, ctx.tenantId), eq(journalLine.accountId, q.accountId));
  const join = and(eq(journalEntry.tenantId, journalLine.tenantId), eq(journalEntry.id, journalLine.entryId));

  const [before] = await ctx.tx
    .select({ net: sql<string>`coalesce(sum(${journalLine.debit} - ${journalLine.credit}), 0)` })
    .from(journalLine)
    .innerJoin(journalEntry, join)
    .where(and(onAccount, lt(journalEntry.businessDate, q.from)));
  const opening = BigInt(before?.net ?? 0);

  const lines = await ctx.tx
    .select({
      entryId: journalEntry.id,
      entryNo: journalEntry.entryNo,
      businessDate: journalEntry.businessDate,
      source: journalEntry.source,
      narration: journalEntry.narration,
      debit: journalLine.debit,
      credit: journalLine.credit,
    })
    .from(journalLine)
    .innerJoin(journalEntry, join)
    .where(and(onAccount, gte(journalEntry.businessDate, q.from), lte(journalEntry.businessDate, q.to)))
    .orderBy(asc(journalEntry.businessDate), asc(journalEntry.entryNo), asc(journalLine.lineNo));

  const entryIds = [...new Set(lines.map((l) => l.entryId))];
  const contraRows = entryIds.length
    ? await ctx.tx
        .selectDistinct({
          entryId: journalLine.entryId,
          code: ledgerAccount.code,
          nameEn: ledgerAccount.nameEn,
          nameBn: ledgerAccount.nameBn,
        })
        .from(journalLine)
        .innerJoin(
          ledgerAccount,
          and(eq(ledgerAccount.tenantId, journalLine.tenantId), eq(ledgerAccount.id, journalLine.accountId)),
        )
        .where(
          and(
            eq(journalLine.tenantId, ctx.tenantId),
            inArray(journalLine.entryId, entryIds),
            ne(journalLine.accountId, q.accountId),
          ),
        )
        .orderBy(asc(ledgerAccount.code))
    : [];
  const contra = new Map<string, CashBookRow["contra"]>();
  for (const c of contraRows) {
    const list = contra.get(c.entryId) ?? [];
    list.push({ code: c.code, nameEn: c.nameEn, nameBn: c.nameBn });
    contra.set(c.entryId, list);
  }

  let balance = opening;
  let receipts = 0n;
  let payments = 0n;
  const rows = lines.map((l) => {
    balance += l.debit - l.credit;
    receipts += l.debit;
    payments += l.credit;
    return { ...l, contra: contra.get(l.entryId) ?? [], receipt: l.debit, payment: l.credit, balance };
  });
  return { accountId: q.accountId, from: q.from, to: q.to, opening, receipts, payments, closing: balance, rows };
}
