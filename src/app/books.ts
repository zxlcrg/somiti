import { getLocale } from "next-intl/server";
import { defaultLocale, isLocale, type Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { primaryName, type BilingualName } from "@/lib/names";

/** The reader's language, for the books pages. */
export async function pageLocale(): Promise<Locale> {
  const raw = await getLocale();
  return isLocale(raw) ? raw : defaultLocale;
}

/** "#12" / "#১২". */
export function voucherNo(n: bigint | number, locale: Locale): string {
  return `#${locale === "bn" ? toBanglaDigits(String(n)) : String(n)}`;
}

/** "1100 · Cash in hand". */
export function accountLabel(a: BilingualName & { code: string }, locale: Locale): string {
  const code = locale === "bn" ? toBanglaDigits(a.code) : a.code;
  return `${code} · ${primaryName(a, locale)}`;
}
