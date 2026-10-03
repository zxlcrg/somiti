import { getLocale, getTranslations } from "next-intl/server";
import { isLocale, defaultLocale } from "@/i18n/config";
import { todayInDhaka } from "@/lib/dates";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";

export default async function Home() {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const t = await getTranslations();
  return (
    <>
      <h1>{t("app.tagline")}</h1>
      <p>{t("home.status")}</p>
      <section className="card">
        <h2>{t("home.sampleHeading")}</h2>
        <dl>
          <dt>{t("home.sampleAmount")}</dt>
          <dd>{formatTaka(1_234_567_850n, locale)}</dd>
          <dt>{t("home.sampleDate")}</dt>
          <dd>{formatDate(todayInDhaka(), locale)}</dd>
          <dt>{t("home.sampleCount")}</dt>
          <dd>{formatInteger(1250, locale)}</dd>
        </dl>
      </section>
    </>
  );
}
