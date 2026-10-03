import { intlLocale, type Locale } from "@/i18n/config";
import type { IsoDate } from "./dates";
import { toTakaDecimal, type Paisa } from "./money";

/** "1,00,000.00" in English, "১,০০,০০০.০০" in Bangla. */
export function formatAmount(paisa: Paisa, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toTakaDecimal(paisa) as `${number}`);
}

/** Amount with the taka sign: "৳1,00,000.00" / "৳১,০০,০০০.০০". */
export function formatTaka(paisa: Paisa, locale: Locale): string {
  const amount = formatAmount(paisa < 0n ? -paisa : paisa, locale);
  return `${paisa < 0n ? "-" : ""}৳${amount}`;
}

export function formatInteger(value: number | bigint, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale[locale]).format(value);
}

/** Calendar date in Dhaka, e.g. "3 October 2026" / "৩ অক্টোবর, ২০২৬". */
export function formatDate(date: IsoDate, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale[locale], {
    dateStyle: "long",
    timeZone: "Asia/Dhaka",
  }).format(new Date(`${date}T00:00:00+06:00`));
}
