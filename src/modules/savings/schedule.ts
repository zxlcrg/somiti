/**
 * Expected versus paid, worked out from the product's schedule rather than
 * stored as one due row per member per day (architecture review, "Dues
 * generation"). The current period counts as due from its first day.
 */

export type SavingsFrequency = "flexible" | "daily" | "weekly" | "monthly";

function toDays(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** How many installments have fallen due from `openedOn` up to and including `asOf`. */
export function periodsDue(frequency: SavingsFrequency, openedOn: string, asOf: string): number {
  if (frequency === "flexible" || asOf < openedOn) return 0;
  const days = toDays(asOf) - toDays(openedOn);
  if (frequency === "daily") return days + 1;
  if (frequency === "weekly") return Math.floor(days / 7) + 1;
  const [oy, om] = openedOn.split("-").map(Number) as [number, number];
  const [ay, am] = asOf.split("-").map(Number) as [number, number];
  return (ay - oy) * 12 + (am - om) + 1;
}

export interface DueStatus {
  /** Installments fallen due so far. */
  periods: number;
  expected: bigint;
  paid: bigint;
  /** Positive: behind by this much. Zero: up to date. Negative: paid ahead. */
  behind: bigint;
  /** Unpaid from periods already over (the current one isn't late yet). */
  overdue: bigint;
}

export function dueStatus(
  frequency: SavingsFrequency,
  installment: bigint | null,
  openedOn: string,
  asOf: string,
  paid: bigint,
): DueStatus | null {
  if (frequency === "flexible" || !installment) return null;
  const periods = periodsDue(frequency, openedOn, asOf);
  const expected = BigInt(periods) * installment;
  const over = BigInt(Math.max(periods - 1, 0)) * installment - paid;
  return { periods, expected, paid, behind: expected - paid, overdue: over > 0n ? over : 0n };
}

/**
 * The late fine on a deposit: the product's fine for each overdue
 * installment the deposit starts paying. An installment already part-paid
 * was fined then, so finishing it costs nothing more. Money beyond what is
 * overdue goes to the current period and draws no fine.
 */
export function lateFineFor(
  rule: { installment: bigint | null; lateFine: bigint | null; due: Pick<DueStatus, "paid" | "overdue"> | null },
  amount: bigint,
): { installments: number; fine: bigint } {
  const { installment, lateFine, due } = rule;
  if (!installment || !lateFine || !due || due.overdue <= 0n || amount <= 0n) return { installments: 0, fine: 0n };
  const late = amount < due.overdue ? amount : due.overdue;
  const started = (paid: bigint) => (paid + installment - 1n) / installment;
  const k = started(due.paid + late) - started(due.paid);
  return { installments: Number(k), fine: k * lateFine };
}
