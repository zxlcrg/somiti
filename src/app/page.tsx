import { getLocale, getTranslations } from "next-intl/server";
import { isLocale, defaultLocale } from "@/i18n/config";
import { todayInDhaka } from "@/lib/dates";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { AmountPlayground } from "./home/amount-playground";
import { BalanceDemo } from "./home/balance-demo";

const icons = {
  ledger: "M4 5h16M4 10h16M4 15h10M4 20h7",
  tenant: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z",
  bilingual: "M4 6h8M8 4v2m-3 0c0 4 3 7 6 8m-1-8c-1 3-3 6-6 8m9 2l3.5-8 3.5 8m-6-2.5h5",
};

export default async function Home() {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const t = await getTranslations();

  const features = [
    { icon: icons.ledger, title: t("home.features.ledgerTitle"), body: t("home.features.ledgerBody") },
    { icon: icons.tenant, title: t("home.features.tenantTitle"), body: t("home.features.tenantBody") },
    { icon: icons.bilingual, title: t("home.features.bilingualTitle"), body: t("home.features.bilingualBody") },
  ];
  const roadmap = [
    { label: t("home.roadmap.m1"), done: true },
    { label: t("home.roadmap.signin"), done: false },
    { label: t("home.roadmap.vouchers"), done: false },
    { label: t("home.roadmap.trialBalance"), done: false },
  ];

  return (
    <>
      <section className="hero">
        <div className="hero-glow" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="hero-copy">
          <span className="badge">
            <span className="dot" aria-hidden="true" />
            {t("home.badge")}
          </span>
          <h1>{t("home.heroTitle")}</h1>
          <p className="lead">{t("app.tagline")}</p>
          <p className="muted">{t("home.status")}</p>
          <div className="ctas">
            <a className="btn primary" href="#try">
              {t("home.ctaTry")}
            </a>
            <a className="btn ghost" href="#roadmap">
              {t("home.ctaRoadmap")}
            </a>
          </div>
        </div>
        <section className="glass" aria-labelledby="sample-heading">
          <h2 id="sample-heading">{t("home.sampleHeading")}</h2>
          <dl>
            <div className="stat">
              <dt>{t("home.sampleAmount")}</dt>
              <dd className="big">{formatTaka(1_234_567_850n, locale)}</dd>
            </div>
            <div className="stat">
              <dt>{t("home.sampleDate")}</dt>
              <dd>{formatDate(todayInDhaka(), locale)}</dd>
            </div>
            <div className="stat">
              <dt>{t("home.sampleCount")}</dt>
              <dd>{formatInteger(1250, locale)}</dd>
            </div>
          </dl>
        </section>
      </section>

      <section className="duo">
        <AmountPlayground />
        <BalanceDemo />
      </section>

      <section className="features">
        {features.map((f) => (
          <article className="feature" key={f.title}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={f.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </section>

      <section className="roadmap" id="roadmap" aria-labelledby="roadmap-heading">
        <h2 id="roadmap-heading">{t("home.roadmap.title")}</h2>
        <ol>
          {roadmap.map((step) => (
            <li key={step.label} className={step.done ? "done" : undefined}>
              <span className="pill">{step.done ? t("home.roadmap.done") : t("home.roadmap.next")}</span>
              {step.label}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
