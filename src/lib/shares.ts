import { toLatinDigits } from "./digits";

/**
 * Shares of 100%, in basis points (10000 = 100%), so splits stay exact.
 * Used for nominee shares; safe in the browser.
 */

/** "33.33" or "৫০%" -> basis points (3333, 5000); null if not a percentage with up to two decimals. */
export function parseSharePercent(input: string): number | null {
  const text = toLatinDigits(input).trim().replace(/\s*%$/, "");
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp >= 1 && bp <= 10_000 ? bp : null;
}

/** Splits 100% across n shares, giving the leftover basis points to the first ones. */
export function equalShares(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10_000 - base * n ? 1 : 0));
}

/** Basis points back to the plain percent people type: 3334 -> "33.34", 5000 -> "50". */
export function bpToPercentInput(bp: number): string {
  return (bp / 100).toFixed(2).replace(/\.?0+$/, "");
}
