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
  return { periods, expected, paid, behind: expected - paid };
}
