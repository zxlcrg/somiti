import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { loan, tenant } from "@/db/schema";
import { listLoans, type LoanView } from "./loans";

/*
 * Overdue loans, worked out from the schedule and the repayments each time
 * they are read (as savings dues are), so there is no nightly job to miss.
 * Loans are grouped by how long their oldest unpaid installment has been
 * late. The bands are by days only for now: what a somiti calls
 * "substandard" or "doubtful", and what it provisions for each, waits on the
 * accountant (architecture review, loan classification).
 */

export const AGE_BANDS = ["d1_30", "d31_90", "d91_180", "d181"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export function ageBand(daysLate: number): AgeBand {
  if (daysLate <= 30) return "d1_30";
  if (daysLate <= 90) return "d31_90";
  if (daysLate <= 180) return "d91_180";
  return "d181";
}

export interface OverdueLoan {
  loan: LoanView;
  /** Installments past their date and not fully paid. */
  installments: number;
  /** What is owing on them. */
  amount: bigint;
  oldestDue: string;
  daysLate: number;
  band: AgeBand;
}

export interface OverdueSummary {
  /** The business date the scan was made for. */
  today: string;
  loans: OverdueLoan[];
  total: bigint;
  byBand: Record<AgeBand, { count: number; amount: bigint }>;
}

export async function overdueLoans(ctx: TenantTx): Promise<OverdueSummary> {
  const { tx, tenantId } = ctx;
  const [day] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const today = day!.d;
  const rows = await tx.execute<{ loan_id: string; installments: number; amount: string; oldest: string; days: number }>(sql`
    with paid as (
      select x.loan_id, x.seq, sum(x.principal + x.interest + x.rebate) as paid
        from loan_repayment_line x
       where x.tenant_id = ${tenantId}
       group by x.loan_id, x.seq
    ), late as (
      select i.loan_id, i.due_on, i.principal + i.interest - coalesce(p.paid, 0) as owing
        from loan_installment i
        join ${loan} l on l.tenant_id = i.tenant_id and l.id = i.loan_id and l.status = 'disbursed'
        left join paid p on p.loan_id = i.loan_id and p.seq = i.seq
       where i.tenant_id = ${tenantId} and i.due_on < ${today}::date
    )
    select loan_id,
           count(*)::int as installments,
           sum(owing)::text as amount,
           to_char(min(due_on), 'YYYY-MM-DD') as oldest,
           (${today}::date - min(due_on))::int as days
      from late
     where owing > 0
     group by loan_id
     order by min(due_on), loan_id`);
  const byBand = Object.fromEntries(AGE_BANDS.map((b) => [b, { count: 0, amount: 0n }])) as OverdueSummary["byBand"];
  if (!rows.rows.length) return { today, loans: [], total: 0n, byBand };
  const views = await listLoans(ctx, { ids: rows.rows.map((r) => r.loan_id), limit: rows.rows.length });
  const byId = new Map(views.map((v) => [v.id, v]));
  let total = 0n;
  const loans: OverdueLoan[] = rows.rows.map((r) => {
    const amount = BigInt(r.amount);
    const band = ageBand(r.days);
    total += amount;
    byBand[band].count++;
    byBand[band].amount += amount;
    return { loan: byId.get(r.loan_id)!, installments: r.installments, amount, oldestDue: r.oldest, daysLate: r.days, band };
  });
  return { today, loans, total, byBand };
}

/** How many running loans are overdue, for the nav and overview. */
export async function overdueCount(ctx: TenantTx): Promise<number> {
  const { tx, tenantId } = ctx;
  const [day] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(loan)
    .where(
      and(
        eq(loan.tenantId, tenantId),
        inArray(loan.status, ["disbursed"]),
        sql`exists (
          select 1 from loan_installment i
           where i.tenant_id = loan.tenant_id and i.loan_id = loan.id and i.due_on < ${day!.d}::date
             and i.principal + i.interest > coalesce((select sum(x.principal + x.interest + x.rebate) from loan_repayment_line x
                                                       where x.tenant_id = i.tenant_id and x.loan_id = i.loan_id and x.seq = i.seq), 0))`,
      ),
    );
  return row?.n ?? 0;
}
