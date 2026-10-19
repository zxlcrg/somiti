import type { TenantTx } from "@/db/client";
import { AGE_BANDS, listLoans, overdueLoans, type AgeBand, type LoanView } from "@/modules/loans";

/*
 * Loan aging: the running loan book split by how late each loan's oldest
 * unpaid installment is, measured by principal still owed. Portfolio at risk
 * (PAR 30) is the share of that principal on loans more than 30 days late,
 * the figure microfinance regulators and auditors ask for first.
 */

export const AGING_BANDS = ["current", ...AGE_BANDS] as const;
export type AgingBand = "current" | AgeBand;

export interface AgingRow {
  count: number;
  /** Principal still owed on these loans. */
  principal: bigint;
  /** Installment amounts past due and unpaid. */
  overdue: bigint;
}

export interface AgingLoan {
  loan: LoanView;
  band: AgingBand;
  principal: bigint;
  overdue: bigint;
  daysLate: number;
}

export interface ProductAging {
  product: LoanView["product"];
  count: number;
  principal: bigint;
  /** Principal on loans more than 30 days late. */
  atRisk: bigint;
}

export interface LoanAging {
  today: string;
  total: AgingRow;
  bands: Record<AgingBand, AgingRow>;
  /** Principal on loans more than 30 days late, and its share of the book in basis points. */
  atRisk: bigint;
  parBp: number;
  products: ProductAging[];
  /** Late loans, most days late first. */
  late: AgingLoan[];
}

const MAX_LOANS = 20_000;

export async function loanAging(ctx: TenantTx): Promise<LoanAging> {
  const overdue = await overdueLoans(ctx);
  const running = await listLoans(ctx, { status: "disbursed", limit: MAX_LOANS });
  const late = new Map(overdue.loans.map((o) => [o.loan.id, o]));
  const empty = (): AgingRow => ({ count: 0, principal: 0n, overdue: 0n });
  const bands = Object.fromEntries(AGING_BANDS.map((b) => [b, empty()])) as Record<AgingBand, AgingRow>;
  const total = empty();
  const products = new Map<string, ProductAging>();
  const lateLoans: AgingLoan[] = [];
  let atRisk = 0n;

  for (const loan of running) {
    const principal = loan.principal - loan.paidPrincipal;
    const o = late.get(loan.id);
    const band: AgingBand = o ? o.band : "current";
    const owed = o?.amount ?? 0n;
    for (const row of [bands[band], total]) {
      row.count++;
      row.principal += principal;
      row.overdue += owed;
    }
    const risky = o !== undefined && o.daysLate > 30;
    if (risky) atRisk += principal;
    const p = products.get(loan.product.id) ?? { product: loan.product, count: 0, principal: 0n, atRisk: 0n };
    p.count++;
    p.principal += principal;
    if (risky) p.atRisk += principal;
    products.set(loan.product.id, p);
    if (o) lateLoans.push({ loan, band, principal, overdue: owed, daysLate: o.daysLate });
  }

  return {
    today: overdue.today,
    total,
    bands,
    atRisk,
    parBp: total.principal > 0n ? Number((atRisk * 10_000n) / total.principal) : 0,
    products: [...products.values()].sort((a, b) => a.product.code.localeCompare(b.product.code)),
    late: lateLoans.sort((a, b) => b.daysLate - a.daysLate),
  };
}
