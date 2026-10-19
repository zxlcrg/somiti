import { sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";

/*
 * A member's statement: everything that moved their savings, shares or loans
 * between two business dates, as a passbook would show it. Built from the
 * member records rather than the ledger, so it reads in the member's terms
 * (a repayment is one line with its principal, charge and fine, not three).
 * A row that was later undone through a correction stays on the statement,
 * marked, and doesn't count.
 */

export type StatementKind =
  | "savings_opening"
  | "savings_deposit"
  | "savings_withdrawal"
  | "share_opening"
  | "share_purchase"
  | "share_refund"
  | "loan_opening"
  | "loan_disbursement"
  | "loan_repayment"
  | "loan_write_off";

export interface StatementRow {
  businessDate: string;
  entryNo: bigint;
  kind: StatementKind;
  /** Savings account number, share count or loan number, by kind. */
  ref: number;
  /** Change to the member's savings, shares (in taka) and loan principal owed. */
  savings: bigint;
  shares: bigint;
  loan: bigint;
  /** Service charge or interest, late fines and fees the member paid with this row. */
  charge: bigint;
  fine: bigint;
  fee: bigint;
  /** Money the member handed over, and money paid out to them. */
  paidIn: bigint;
  paidOut: bigint;
  reversed: boolean;
  /** Balances after this row. */
  savingsAfter: bigint;
  sharesAfter: bigint;
  loanAfter: bigint;
}

export interface Balances {
  savings: bigint;
  shares: bigint;
  loan: bigint;
}

export interface MemberStatement {
  from: string;
  to: string;
  opening: Balances;
  closing: Balances;
  rows: StatementRow[];
  totals: { paidIn: bigint; paidOut: bigint; charge: bigint; fine: bigint; fee: bigint };
}

const live = (alias: string) =>
  sql.raw(`not exists (select 1 from journal_entry rev where rev.tenant_id = ${alias}.tenant_id and rev.reverses_id = ${alias}.journal_entry_id)`);
const entryNo = (alias: string, column = "journal_entry_id") =>
  sql.raw(`(select je.entry_no from journal_entry je where je.tenant_id = ${alias}.tenant_id and je.id = ${alias}.${column})`);

type Raw = {
  business_date: string;
  entry_no: string;
  kind: StatementKind;
  ref: number;
  savings: string;
  shares: string;
  loan: string;
  charge: string;
  fine: string;
  fee: string;
  paid_in: string;
  paid_out: string;
  reversed: boolean;
};

export async function memberStatement(ctx: TenantTx, q: { memberId: string; from: string; to: string }): Promise<MemberStatement> {
  const { tenantId } = ctx;
  const m = q.memberId;
  const res = await ctx.tx.execute<Raw>(sql`
    select * from (
      select t.business_date::text, ${entryNo("t")} as entry_no, t.created_at,
             'savings_' || t.kind as kind, a.account_no as ref,
             case when t.kind = 'withdrawal' then -t.amount else t.amount end as savings, 0 as shares, 0 as loan,
             0 as charge, coalesce(f.amount, 0) as fine, 0 as fee,
             case when t.kind = 'deposit' then t.amount + coalesce(f.amount, 0) else 0 end as paid_in,
             case when t.kind = 'withdrawal' then t.amount else 0 end as paid_out,
             not ${live("t")} as reversed
        from savings_transaction t
        join savings_account a on a.tenant_id = t.tenant_id and a.id = t.account_id
        left join savings_fine f on f.tenant_id = t.tenant_id and f.journal_entry_id = t.journal_entry_id
       where t.tenant_id = ${tenantId} and a.member_id = ${m}
      union all
      select s.business_date::text, ${entryNo("s")}, s.created_at,
             'share_' || s.kind, s.shares,
             0, case when s.kind = 'refund' then -s.amount else s.amount end, 0,
             0, 0, 0,
             case when s.kind = 'purchase' then s.amount else 0 end,
             case when s.kind = 'refund' then s.amount else 0 end,
             not ${live("s")}
        from share_transaction s
       where s.tenant_id = ${tenantId} and s.member_id = ${m}
      union all
      select coalesce(l.imported_on, l.disbursed_on)::text, ${entryNo("l", "entry_id")}, l.decided_at,
             case when l.imported_on is null then 'loan_disbursement' else 'loan_opening' end, l.loan_no,
             0, 0, l.principal,
             0, 0, case when l.imported_on is null then l.processing_fee else 0 end,
             0, case when l.imported_on is null then l.principal - l.processing_fee else 0 end,
             false
        from loan l
       where l.tenant_id = ${tenantId} and l.member_id = ${m} and l.entry_id is not null
      union all
      select p.business_date::text, ${entryNo("p")}, p.created_at,
             'loan_repayment', l.loan_no,
             0, 0, -p.principal,
             p.interest, p.fine, 0,
             p.amount + p.fine, 0,
             not ${live("p")}
        from loan_repayment p
        join loan l on l.tenant_id = p.tenant_id and l.id = p.loan_id
       where p.tenant_id = ${tenantId} and l.member_id = ${m}
      union all
      select (select je.business_date from journal_entry je where je.tenant_id = w.tenant_id and je.id = w.entry_id)::text,
             ${entryNo("w", "entry_id")}, w.decided_at,
             'loan_write_off', l.loan_no,
             0, 0, -w.principal,
             0, 0, 0, 0, 0,
             false
        from loan_write_off w
        join loan l on l.tenant_id = w.tenant_id and l.id = w.loan_id
       where w.tenant_id = ${tenantId} and l.member_id = ${m} and w.status = 'approved'
    ) rows
    where business_date <= ${q.to}
    order by business_date, entry_no`);

  const opening: Balances = { savings: 0n, shares: 0n, loan: 0n };
  const running: Balances = { savings: 0n, shares: 0n, loan: 0n };
  const totals = { paidIn: 0n, paidOut: 0n, charge: 0n, fine: 0n, fee: 0n };
  const rows: StatementRow[] = [];
  for (const r of res.rows) {
    const row = {
      businessDate: r.business_date,
      entryNo: BigInt(r.entry_no),
      kind: r.kind,
      ref: Number(r.ref),
      savings: BigInt(r.savings),
      shares: BigInt(r.shares),
      loan: BigInt(r.loan),
      charge: BigInt(r.charge),
      fine: BigInt(r.fine),
      fee: BigInt(r.fee),
      paidIn: BigInt(r.paid_in),
      paidOut: BigInt(r.paid_out),
      reversed: r.reversed,
    };
    if (!row.reversed) {
      running.savings += row.savings;
      running.shares += row.shares;
      running.loan += row.loan;
    }
    if (row.businessDate < q.from) {
      Object.assign(opening, running);
      continue;
    }
    if (!row.reversed) {
      totals.paidIn += row.paidIn;
      totals.paidOut += row.paidOut;
      totals.charge += row.charge;
      totals.fine += row.fine;
      totals.fee += row.fee;
    }
    rows.push({ ...row, savingsAfter: running.savings, sharesAfter: running.shares, loanAfter: running.loan });
  }
  return { from: q.from, to: q.to, opening, closing: { ...running }, rows, totals };
}
