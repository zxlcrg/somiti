import { toLatinDigits } from "./digits";

/**
 * Money is always a bigint count of paisa (1 taka = 100 paisa). Never use
 * floating point for amounts.
 */
export type Paisa = bigint;

export const PAISA_PER_TAKA = 100n;

const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parses what a person typed into a paisa amount. Accepts Bangla or Latin
 * digits, lakh/crore or western grouping commas, and an optional ৳ or Tk
 * prefix: "১,০০০.৫০", "1,000.5" and "৳ 1000.50" all give 100050n.
 * Returns null for anything else, including negatives and more than two
 * decimal places.
 */
export function parseTaka(input: string): Paisa | null {
  const cleaned = toLatinDigits(input)
    .trim()
    .replace(/^(৳|tk\.?|taka)\s*/i, "")
    .replace(/[,\s]/g, "");
  const match = AMOUNT.exec(cleaned);
  if (!match) return null;
  const taka = BigInt(match[1]!);
  const paisa = BigInt((match[2] ?? "").padEnd(2, "0"));
  return taka * PAISA_PER_TAKA + paisa;
}

/** Exact decimal string in taka, e.g. 100050n -> "1000.50". Suitable for Intl.NumberFormat. */
export function toTakaDecimal(paisa: Paisa): string {
  const negative = paisa < 0n;
  const abs = negative ? -paisa : paisa;
  const taka = abs / PAISA_PER_TAKA;
  const rest = (abs % PAISA_PER_TAKA).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${taka}.${rest}`;
}

/**
 * The one rounding rule for the whole system: computes a * b / c and rounds
 * half away from zero (0.5 paisa rounds up for positive amounts). Interest,
 * fines and dividends must all go through this or a function built on it.
 *
 * Half away from zero is the common commercial rule; the cooperative
 * accountant should confirm it in M0.
 */
export function mulDivRound(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new RangeError("Division by zero");
  const numerator = a * b;
  const negative = numerator < 0n !== c < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = c < 0n ? -c : c;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Applies a rate in basis points (1% = 100 bp), e.g. interest for one period. */
export function applyBasisPoints(amount: Paisa, basisPoints: bigint): Paisa {
  return mulDivRound(amount, basisPoints, 10_000n);
}
