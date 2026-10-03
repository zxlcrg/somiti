import { getLocale, getTranslations } from "next-intl/server";
import { locales } from "@/i18n/config";
import { setLocale } from "./actions";

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
          {t(locale)}
        </button>
      ))}
    </form>
  );
}
