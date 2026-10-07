import { getLocale, getTranslations } from "next-intl/server";
import { locales } from "@/i18n/config";
import { setLocale } from "./actions";

// Each language's own short name, shown instead of the full name on narrow phones.
const SHORT: Record<string, string> = { en: "EN", bn: "বাং" };

export async function LanguageSwitcher() {
  const current = await getLocale();
  const t = await getTranslations("language");
  return (
    <form action={setLocale} className="switcher" aria-label={t("label")}>
      {locales.map((locale) => (
        <button
          key={locale}
          type="submit"
          name="locale"
          value={locale}
          aria-pressed={locale === current}
          lang={locale}
        >
          <span className="lang-full">{t(locale)}</span>
          <span className="lang-short" aria-hidden="true">
            {SHORT[locale]}
          </span>
        </button>
      ))}
    </form>
  );
}
