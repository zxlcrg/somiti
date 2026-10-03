export const locales = ["en", "bn"] as const;
export type Locale = (typeof locales)[number];

/** Somiti default until a tenant sets its own. */
export const defaultLocale: Locale = "en";

/** Cookie holding the signed-out UI language. Signed-in users will use app_user.locale. */
export const LOCALE_COOKIE = "somiti_locale";

/**
 * Intl locales. Both use lakh/crore grouping (1,00,000); bn-BD also gives
 * Bangla digits.
 */
export const intlLocale: Record<Locale, string> = {
  en: "en-IN",
  bn: "bn-BD",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Picks the language for one person: their own setting, else the somiti
 * default. Used for the UI language (app_user.locale) and, from M2, the
 * member's communication language for SMS and receipts.
 */
export function resolveLocale(own: Locale | null | undefined, somitiDefault: Locale): Locale {
  return own ?? somitiDefault;
}
