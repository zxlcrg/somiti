import { parseCsv } from "@/lib/csv";
import { toLatinDigits } from "@/lib/digits";
import { parseTaka } from "@/lib/money";
import { normalizeBdPhone } from "@/lib/phone";
import { validateAdmission } from "@/modules/members/validation";

/** Fixed columns of the opening-balance sheet; one more column follows per savings product code. */
export const MEMBER_COLUMNS = ["name_en", "name_bn", "phone", "admission_date", "shares"] as const;
export const MAX_OPENING_ROWS = 2000;
/** 10 crore taka, far above any one member's balance; catches a slipped digit. */
export const MAX_OPENING_AMOUNT = 10_000_000_000n;
const MAX_OPENING_SHARES = 100_000;

export type OpeningHeaderError =
  | { code: "empty_file" }
  | { code: "too_many_rows"; max: number }
  | { code: "missing_column"; column: "name" | "phone" }
  | { code: "unknown_column"; column: string }
  | { code: "inactive_product"; column: string }
  | { code: "duplicate_column"; column: string };

export type OpeningErrorCode =
  | "name_required"
  | "invalid_phone"
  | "invalid_date"
  | "admission_after_business_date"
  | "too_long"
  | "invalid_shares"
  | "invalid_amount"
  | "amount_too_large"
  | "nothing_to_import";

export interface OpeningRowError {
  /** Line in the file, counting the header as line 1, as Excel numbers rows. */
  line: number;
  column: string;
  code: OpeningErrorCode;
}

export interface OpeningRow {
  line: number;
  nameEn: string | null;
  nameBn: string | null;
  /** +8801XXXXXXXXX */
  phone: string;
  admissionDate: string | null;
  shares: number;
  /** Product code to opening balance in paisa. A product left blank gets no account. */
  balances: Record<string, bigint>;
}

export interface OpeningProduct {
  code: string;
  active: boolean;
}

export interface OpeningTotals {
  members: number;
  shares: number;
  shareAmount: bigint;
  /** Per product code: accounts to open and their total balance. */
  savings: Record<string, { accounts: number; amount: bigint }>;
  savingsAmount: bigint;
}

export interface OpeningPreview {
  headerErrors: OpeningHeaderError[];
  errors: OpeningRowError[];
  rows: OpeningRow[];
  /** Product codes in the order of their columns. */
  productCodes: string[];
  totals: OpeningTotals;
}

const key = (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_");

/**
 * Dates as people type them in Bangladesh: 2024-01-31, 31/01/2024,
 * 31-01-2024 or 31.01.2024, in Latin or Bangla digits. Returns the ISO date.
 */
export function parseSheetDate(input: string): string | null {
  const text = toLatinDigits(input).trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Excel turns 01712345678 into 1712345678; put the zero back before checking. */
function sheetPhone(input: string): string | null {
  const digits = toLatinDigits(input).replace(/[\s\-().]/g, "");
  return normalizeBdPhone(/^1[3-9]\d{8}$/.test(digits) ? `0${digits}` : digits);
}

function emptyTotals(codes: string[]): OpeningTotals {
  return {
    members: 0,
    shares: 0,
    shareAmount: 0n,
    savings: Object.fromEntries(codes.map((c) => [c, { accounts: 0, amount: 0n }])),
    savingsAmount: 0n,
  };
}

/**
 * Reads the opening-balance sheet and checks every row without touching the
 * database, so the preview and the final import agree. Header problems stop
 * the rows from being read at all.
 */
export function parseOpeningSheet(
  text: string,
  opts: { products: readonly OpeningProduct[]; businessDate: string; sharePrice: bigint },
): OpeningPreview {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const blank: OpeningPreview = { headerErrors: [], errors: [], rows: [], productCodes: [], totals: emptyTotals([]) };
  if (all.length < 2) return { ...blank, headerErrors: [{ code: "empty_file" }] };
  if (all.length - 1 > MAX_OPENING_ROWS) return { ...blank, headerErrors: [{ code: "too_many_rows", max: MAX_OPENING_ROWS }] };

  // Line numbers count blank lines too, so they match what Excel shows.
  const lines = parseCsv(text);
  const header = all[0]!.map(key);
  const headerErrors: OpeningHeaderError[] = [];
  const byCode = new Map(opts.products.map((p) => [p.code.toLowerCase(), p]));
  const columns = new Map<string, number>();
  const productCodes: string[] = [];
  header.forEach((h, i) => {
    if (!h) return;
    if (columns.has(h)) headerErrors.push({ code: "duplicate_column", column: all[0]![i]!.trim() });
    columns.set(h, i);
    if ((MEMBER_COLUMNS as readonly string[]).includes(h)) return;
    const product = byCode.get(h);
    if (!product) headerErrors.push({ code: "unknown_column", column: all[0]![i]!.trim() });
    else if (!product.active) headerErrors.push({ code: "inactive_product", column: product.code });
    else productCodes.push(product.code);
  });
  if (!columns.has("name_en") && !columns.has("name_bn")) headerErrors.push({ code: "missing_column", column: "name" });
  if (!columns.has("phone")) headerErrors.push({ code: "missing_column", column: "phone" });
  if (headerErrors.length) return { ...blank, headerErrors };

  const errors: OpeningRowError[] = [];
  const rows: OpeningRow[] = [];
  const totals = emptyTotals(productCodes);
  const headerLine = lines.findIndex((r) => r.some((c) => c.trim() !== ""));

  for (let n = headerLine + 1; n < lines.length; n++) {
    const cells = lines[n]!;
    if (!cells.some((c) => c.trim() !== "")) continue;
    const line = n + 1;
    const cell = (name: string) => {
      const i = columns.get(name);
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const fail = (column: string, code: OpeningErrorCode) => errors.push({ line, column, code });
    const before = errors.length;

    const nameEn = cell("name_en") || null;
    const nameBn = cell("name_bn") || null;
    const phone = sheetPhone(cell("phone"));
    const dateText = cell("admission_date");
    const admissionDate = dateText ? parseSheetDate(dateText) : null;

    const checked = validateAdmission({
      nameEn: nameEn ?? undefined,
      nameBn: nameBn ?? undefined,
      phone: phone ?? "",
      admissionDate: admissionDate ?? undefined,
    });
    if (!checked.ok) {
      if (checked.errors.nameEn === "name_required") fail("name_en", "name_required");
      else if (checked.errors.nameEn === "too_long") fail("name_en", "too_long");
      if (checked.errors.nameBn === "too_long") fail("name_bn", "too_long");
    }
    if (!phone) fail("phone", "invalid_phone");
    if (dateText && !admissionDate) fail("admission_date", "invalid_date");
    else if (admissionDate && admissionDate > opts.businessDate) fail("admission_date", "admission_after_business_date");

    let shares = 0;
    const sharesText = toLatinDigits(cell("shares")).replace(/[,\s]/g, "");
    if (sharesText) {
      shares = /^\d+$/.test(sharesText) ? Number(sharesText) : -1;
      if (shares < 0 || shares > MAX_OPENING_SHARES) fail("shares", "invalid_shares");
    }

    const balances: Record<string, bigint> = {};
    for (const code of productCodes) {
      const text = cell(code.toLowerCase());
      if (!text) continue;
      const paisa = parseTaka(text);
      if (paisa === null || paisa < 0n) fail(code, "invalid_amount");
      else if (paisa > MAX_OPENING_AMOUNT) fail(code, "amount_too_large");
      else balances[code] = paisa;
    }

    if (errors.length > before) continue;
    rows.push({ line, nameEn, nameBn, phone: phone!, admissionDate, shares, balances });
    totals.members++;
    totals.shares += shares;
    totals.shareAmount += BigInt(shares) * opts.sharePrice;
    for (const [code, amount] of Object.entries(balances)) {
      totals.savings[code]!.accounts++;
      totals.savings[code]!.amount += amount;
      totals.savingsAmount += amount;
    }
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: headerLine + 2, column: "", code: "nothing_to_import" });
  return { headerErrors, errors, rows, productCodes, totals };
}

/** The sheet to download: the fixed columns, then one per active savings product. */
export function openingTemplateHeader(products: readonly OpeningProduct[]): string[] {
  return [...MEMBER_COLUMNS, ...products.filter((p) => p.active).map((p) => p.code)];
}
