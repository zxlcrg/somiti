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

export interface ControlBalance {
  accountId: string;
  /** Net balance, debit positive, as of the date. */
  total: bigint;
  /** Net balance per member the lines were tagged with. */
  byMember: Map<string, bigint>;
  /** Net balance of lines that name no member. */
  untagged: bigint;
}

/**
 * Balances of the accounts that hold member money, split by the member each
 * journal line names, so they can be held up against the member records.
 */
export async function controlBalances<K extends string>(
  ctx: TenantTx,
  accounts: Record<K, string>,
  asOf: string,
): Promise<Record<K, ControlBalance>> {
  const ids = Object.values<string>(accounts);
  const rows = ids.length
    ? await ctx.tx
        .select({
          accountId: journalLine.accountId,
          memberId: journalLine.memberId,
          net: sql<string>`sum(${journalLine.debit} - ${journalLine.credit})`,
        })
        .from(journalLine)
        .innerJoin(journalEntry, and(eq(journalEntry.tenantId, journalLine.tenantId), eq(journalEntry.id, journalLine.entryId)))
        .where(and(eq(journalLine.tenantId, ctx.tenantId), inArray(journalLine.accountId, ids), lte(journalEntry.businessDate, asOf)))
        .groupBy(journalLine.accountId, journalLine.memberId)
    : [];
  const out = {} as Record<K, ControlBalance>;
  for (const key of Object.keys(accounts) as K[]) {
    const balance: ControlBalance = { accountId: accounts[key], total: 0n, byMember: new Map(), untagged: 0n };
    for (const r of rows.filter((x) => x.accountId === accounts[key])) {
      const net = BigInt(r.net);
      balance.total += net;
      if (r.memberId) balance.byMember.set(r.memberId, net);
      else balance.untagged += net;
    }
    out[key] = balance;
  }
  return out;
}

// ---------- Financial statements ----------

type AccountType = TrialBalanceRow["type"];

export interface StatementLine {
  accountId: string;
  code: string;
  nameEn: string | null;
  nameBn: string | null;
  /** Balance on the account's normal side: debit for assets and expenses, credit for the rest. Negative when it runs the other way. */
  amount: bigint;
}

/** Net balance per account for entries dated in [from, to]; `from` omitted means since the start. */
async function accountNets(ctx: TenantTx, q: { from?: string; to: string; types: readonly AccountType[] }) {
  const dated = q.from
    ? and(gte(journalEntry.businessDate, q.from), lte(journalEntry.businessDate, q.to))
    : lte(journalEntry.businessDate, q.to);
  const rows = await ctx.tx
    .select({
      accountId: ledgerAccount.id,
      code: ledgerAccount.code,
      nameEn: ledgerAccount.nameEn,
      nameBn: ledgerAccount.nameBn,
      type: ledgerAccount.type,
      net: sql<string>`sum(${journalLine.debit} - ${journalLine.credit})`,
    })
    .from(journalLine)
    .innerJoin(journalEntry, and(eq(journalEntry.tenantId, journalLine.tenantId), eq(journalEntry.id, journalLine.entryId)))
    .innerJoin(ledgerAccount, and(eq(ledgerAccount.tenantId, journalLine.tenantId), eq(ledgerAccount.id, journalLine.accountId)))
    .where(and(eq(journalLine.tenantId, ctx.tenantId), dated, inArray(ledgerAccount.type, [...q.types])))
    .groupBy(ledgerAccount.id)
    .orderBy(asc(ledgerAccount.code));
  const byType = new Map<AccountType, StatementLine[]>(q.types.map((t) => [t, []]));
  for (const r of rows) {
    const debitSide = BigInt(r.net);
    if (debitSide === 0n) continue;
    const amount = r.type === "asset" || r.type === "expense" ? debitSide : -debitSide;
    byType.get(r.type)!.push({ accountId: r.accountId, code: r.code, nameEn: r.nameEn, nameBn: r.nameBn, amount });
  }
  return byType;
}

const total = (lines: StatementLine[]) => lines.reduce((s, l) => s + l.amount, 0n);

export interface IncomeStatement {
  from: string;
  to: string;
  income: StatementLine[];
  expenses: StatementLine[];
  totalIncome: bigint;
  totalExpenses: bigint;
  /** Income less expenses; negative is a deficit. */
  surplus: bigint;
}

/** Income and expenses for business dates from..to (inclusive). */
export async function incomeStatement(ctx: TenantTx, q: { from: string; to: string }): Promise<IncomeStatement> {
  const nets = await accountNets(ctx, { from: q.from, to: q.to, types: ["income", "expense"] });
  const income = nets.get("income")!;
  const expenses = nets.get("expense")!;
  const totalIncome = total(income);
  const totalExpenses = total(expenses);
  return { ...q, income, expenses, totalIncome, totalExpenses, surplus: totalIncome - totalExpenses };
}

export interface BalanceSheet {
  asOf: string;
  assets: StatementLine[];
  liabilities: StatementLine[];
  equity: StatementLine[];
  /**
   * Income less expenses still sitting in the income and expense accounts,
   * i.e. not yet closed into the surplus account at year end. Shown under
   * equity so the sheet balances before the year is closed.
   */
  unclosedSurplus: bigint;
  totalAssets: bigint;
  totalLiabilities: bigint;
  totalEquity: bigint;
  /** Liabilities + equity + unclosed surplus; equals totalAssets when the books balance. */
  totalClaims: bigint;
}

/** Position on a business date, from every entry dated on or before it. */
export async function balanceSheet(ctx: TenantTx, asOf: string): Promise<BalanceSheet> {
  const nets = await accountNets(ctx, { to: asOf, types: ["asset", "liability", "equity", "income", "expense"] });
  const assets = nets.get("asset")!;
  const liabilities = nets.get("liability")!;
  const equity = nets.get("equity")!;
  const unclosedSurplus = total(nets.get("income")!) - total(nets.get("expense")!);
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  const totalEquity = total(equity) + unclosedSurplus;
  return {
    asOf,
    assets,
    liabilities,
    equity,
    unclosedSurplus,
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalClaims: totalLiabilities + totalEquity,
  };
}
