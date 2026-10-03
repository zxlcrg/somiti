import { and, asc, eq, lte, sql } from "drizzle-orm";
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
