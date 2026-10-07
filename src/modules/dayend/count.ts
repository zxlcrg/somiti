import { toLatinDigits } from "@/lib/digits";

/** Bangladeshi notes and coins, largest first, in taka. */
export const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
/** More of one note than any somiti drawer holds; guards against typos. */
const MAX_PIECES = 100_000;

/** Totals a count; returns null for any piece count that isn't a whole number in range. */
export function countCash(pieces: Partial<Record<string, string>>, other: bigint): { counted: bigint; breakdown: Record<string, number> } | null {
  const breakdown: Record<string, number> = {};
  let counted = other;
  for (const d of DENOMINATIONS) {
    const text = toLatinDigits(pieces[String(d)]?.trim() ?? "");
    if (!text) continue;
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    if (n > MAX_PIECES) return null;
    if (n > 0) breakdown[String(d)] = n;
    counted += BigInt(d) * 100n * BigInt(n);
  }
  if (other > 0n) breakdown.other = Number(other);
  return { counted, breakdown };
}
