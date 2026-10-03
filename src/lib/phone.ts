import { toLatinDigits } from "./digits";

/**
 * Bangladesh mobile numbers: 01 followed by an operator digit (3–9) and
 * eight more digits. Accepts Bangla or Latin digits, spaces and dashes, and
 * the 01…, 8801… or +8801… forms. Returns the +8801XXXXXXXXX form stored in
 * app_user.phone, or null.
 */
export function normalizeBdPhone(input: string): string | null {
  const digits = toLatinDigits(input).replace(/[\s\-().]/g, "");
  const match = /^(?:\+?88)?(01[3-9]\d{8})$/.exec(digits);
  return match ? `+88${match[1]}` : null;
}

/** "+8801712345678" -> "01712-345678", the way people write it. */
export function formatBdPhone(phone: string): string {
  const local = phone.replace(/^\+88/, "");
  return /^01\d{9}$/.test(local) ? `${local.slice(0, 5)}-${local.slice(5)}` : phone;
}
