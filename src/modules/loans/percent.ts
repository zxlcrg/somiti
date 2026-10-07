import { toLatinDigits } from "@/lib/digits";

/** "12", "12.5" or "১২.৫" percent to basis points; null when it isn't a percentage up to `max`. */
export function parsePercent(input: string | undefined, maxBp: number): number | null {
  const text = toLatinDigits(input ?? "").trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= maxBp ? bp : null;
}
