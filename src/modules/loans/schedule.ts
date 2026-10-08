import { addDays, addMonths, type IsoDate } from "@/lib/dates";
import { mulDivRound } from "@/lib/money";

export type LoanMethod = "flat" | "declining";
export type LoanFrequency = "weekly" | "monthly";

export const PERIODS_PER_YEAR: Record<LoanFrequency, bigint> = { weekly: 52n, monthly: 12n };
const TAKA = 100n;

export interface LoanTerms {
  principal: bigint;
  method: LoanMethod;
  /** Yearly rate in basis points. */
  rateBp: number;
  frequency: LoanFrequency;
  installments: number;
}

export interface ScheduledInstallment {
  seq: number;
  dueOn: IsoDate;
  principal: bigint;
  interest: bigint;
}

/** Installment `seq` falls one period after the previous one, starting a period after disbursement. */
export function dueDate(disbursedOn: IsoDate, frequency: LoanFrequency, seq: number): IsoDate {
  return frequency === "weekly" ? addDays(disbursedOn, 7 * seq) : addMonths(disbursedOn, seq);
}

/** One period's interest on a balance, by the system's single rounding rule. */
function periodInterest(balance: bigint, rateBp: number, frequency: LoanFrequency): bigint {
  return mulDivRound(balance, BigInt(rateBp), 10_000n * PERIODS_PER_YEAR[frequency]);
}

/**
 * Splits `total` into `n` parts: every part but the last is the same whole-taka
 * amount, rounded up so the last part is the small one, unless rounding up
 * would leave nothing for it, in which case down.
 */
function evenParts(total: bigint, n: bigint): bigint[] {
  const down = (total / n / TAKA) * TAKA;
  const up = down * n === total ? down : down + TAKA;
  const each = up * (n - 1n) < total ? up : down;
  return Array.from({ length: Number(n) }, (_, k) => (BigInt(k) < n - 1n ? each : total - each * (n - 1n)));
}

/**
 * Flat: interest on the full principal for the whole term, charged evenly.
 * Every installment but the last is the same whole-taka amount; the last
 * takes what is left, so the totals are exact.
 */
function flat(t: LoanTerms): { principal: bigint; interest: bigint }[] {
  const n = BigInt(t.installments);
  const totalInterest = mulDivRound(t.principal, BigInt(t.rateBp) * n, 10_000n * PERIODS_PER_YEAR[t.frequency]);
  const principal = evenParts(t.principal, n);
  const interest = evenParts(totalInterest, n);
  return principal.map((p, k) => ({ principal: p, interest: interest[k]! }));
}

function amortize(t: LoanTerms, payment: bigint): { rows: { principal: bigint; interest: bigint }[]; left: bigint } {
  let balance = t.principal;
  const rows: { principal: bigint; interest: bigint }[] = [];
  for (let k = 0; k < t.installments; k++) {
    const interest = periodInterest(balance, t.rateBp, t.frequency);
    let principal = payment - interest;
    if (principal < 0n) principal = 0n;
    if (principal > balance || k === t.installments - 1) principal = balance;
    balance -= principal;
    rows.push({ principal, interest });
  }
  return { rows, left: balance };
}

/**
 * Declining balance with equal installments: the smallest whole-taka payment
 * that clears the loan in time, found by search so every figure comes from
 * the integer rounding rule rather than floating-point annuity maths. Each
 * period's interest is on what is still owed; the last installment is
 * whatever clears the balance.
 */
function declining(t: LoanTerms): { principal: bigint; interest: bigint }[] {
  if (t.rateBp === 0) return flat(t);
  const clears = (taka: bigint) => {
    // Only the last row may exceed the payment; a payment that clears early or exactly is enough.
    const { rows } = amortize(t, taka * TAKA);
    const last = rows[rows.length - 1]!;
    return last.principal + last.interest <= taka * TAKA;
  };
  let lo = 1n;
  let hi = (t.principal + periodInterest(t.principal, t.rateBp, t.frequency)) / TAKA + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (clears(mid)) hi = mid;
    else lo = mid + 1n;
  }
  const rows = amortize(t, lo * TAKA).rows;
  // A payment that clears a period early would leave an empty last row; move one taka into it.
  const last = rows[rows.length - 1]!;
  if (rows.length > 1 && last.principal + last.interest === 0n) {
    rows[rows.length - 2]!.principal -= TAKA;
    last.principal = TAKA;
  }
  return rows;
}

/** The repayment schedule for a loan disbursed on `disbursedOn`. */
export function buildSchedule(t: LoanTerms, disbursedOn: IsoDate): ScheduledInstallment[] {
  const rows = t.method === "flat" ? flat(t) : declining(t);
  return rows.map((r, k) => ({ seq: k + 1, dueOn: dueDate(disbursedOn, t.frequency, k + 1), ...r }));
}

export interface ScheduleSummary {
  /** The usual installment: every one but possibly the last. */
  installment: bigint;
  lastInstallment: bigint;
  totalInterest: bigint;
  totalRepayable: bigint;
}

export interface RescheduleTerms {
  /** Principal still owed, all of it moving to the new schedule. */
  principal: bigint;
  /** Charge still owed plus any extra charge agreed for the new term. */
  interest: bigint;
  installments: number;
  frequency: LoanFrequency;
  firstDueOn: IsoDate;
}

/**
 * The new installments a rescheduling writes: principal and charge each
 * spread evenly, by the same whole-taka rule as a flat schedule, one period
 * apart from the first due date. Null when there are too many installments
 * for what is owed (one would come out as nothing).
 */
export function rescheduleRows(t: RescheduleTerms): ScheduledInstallment[] | null {
  const n = BigInt(t.installments);
  const principal = evenParts(t.principal, n);
  const interest = evenParts(t.interest, n);
  const rows = principal.map((p, k) => ({
    seq: k + 1,
    dueOn: t.frequency === "weekly" ? addDays(t.firstDueOn, 7 * k) : addMonths(t.firstDueOn, k),
    principal: p,
    interest: interest[k]!,
  }));
  return rows.every((r) => r.principal >= 0n && r.interest >= 0n && r.principal + r.interest > 0n) ? rows : null;
}

export function summarize(rows: readonly { principal: bigint; interest: bigint }[]): ScheduleSummary {
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0n);
  const totalPrincipal = rows.reduce((s, r) => s + r.principal, 0n);
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  return {
    installment: first.principal + first.interest,
    lastInstallment: last.principal + last.interest,
    totalInterest,
    totalRepayable: totalPrincipal + totalInterest,
  };
}
