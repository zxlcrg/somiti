import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { AGE_BANDS, type AgeBand, canViewLoans, overdueLoans } from "@/modules/loans";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { MemberAvatar } from "../../members/member-avatar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("loans.overdue");
  return { title: t("title") };
}

const isBand = (b: string | undefined): b is AgeBand => AGE_BANDS.includes(b as AgeBand);

/** Running loans with installments past their date, oldest first, grouped by how late. */
export default async function OverduePage({ searchParams }: { searchParams: Promise<{ band?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("loans");
  if (!canViewLoans(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { band: raw } = await searchParams;
  const band = isBand(raw) ? raw : null;
  const summary = await withTenant(getAppDb(), user.tenantId, (ctx) => overdueLoans(ctx));
  const today = summary.today;
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const rows = band ? summary.loans.filter((o) => o.band === band) : summary.loans;
  const share = (a: bigint) => (summary.total > 0n ? Number((a * 1000n) / summary.total) / 10 : 0);

  return (
    <div className="loans overdue-page">
      <Link href="/loans" className="crumb">
        ← {t("title")}
      </Link>
      <header className="page-head">
        <div>
          <h1>
            <span aria-hidden="true">⏰</span> {t("overdue.title")}
          </h1>
          <p className="muted">{t("overdue.subtitle", { date: formatDate(today, locale) })}</p>
        </div>
      </header>

      {summary.loans.length === 0 ? (
        <section className="loan-card all-clear">
          <span aria-hidden="true">🌿</span>
          <h2>{t("overdue.none")}</h2>
          <p className="muted">{t("overdue.noneHint")}</p>
        </section>
      ) : (
        <>
          <section className="loan-card overdue-summary">
            <div className="overdue-total">
              <span>{t("overdue.total")}</span>
              <strong className="money-figure">{taka(summary.total)}</strong>
              <small className="muted">{t("overdue.loans", { count: summary.loans.length, n: num(summary.loans.length) })}</small>
            </div>
            <div className="band-bar" role="img" aria-label={t("overdue.byAge")}>
              {AGE_BANDS.filter((b) => summary.byBand[b].amount > 0n).map((b) => (
                <span key={b} className={`b-${b}`} style={{ width: `${share(summary.byBand[b].amount)}%` }} title={`${t(`overdue.band.${b}`)} · ${taka(summary.byBand[b].amount)}`} />
              ))}
            </div>
            <nav className="band-tiles" aria-label={t("overdue.byAge")}>
              <Link href="/loans/overdue" className={`band-tile all${band ? "" : " on"}`} aria-current={band ? undefined : "page"}>
                <span>{t("overdue.all")}</span>
                <strong>{num(summary.loans.length)}</strong>
                <small>{taka(summary.total)}</small>
              </Link>
              {AGE_BANDS.map((b) => (
                <Link
                  key={b}
                  href={`/loans/overdue?band=${b}`}
                  className={`band-tile b-${b}${band === b ? " on" : ""}${summary.byBand[b].count === 0 ? " zero" : ""}`}
                  aria-current={band === b ? "page" : undefined}
                >
                  <span>
                    <i className="swatch" aria-hidden="true" /> {t(`overdue.band.${b}`)}
                  </span>
                  <strong>{num(summary.byBand[b].count)}</strong>
                  <small>{taka(summary.byBand[b].amount)}</small>
                </Link>
              ))}
            </nav>
          </section>

          <section className="loan-card">
            <h2>{band ? t(`overdue.band.${band}`) : t("overdue.listTitle")}</h2>
            {rows.length === 0 ? (
              <p className="muted all-good">
                <span aria-hidden="true">✨</span> {t("overdue.noneInBand")}
              </p>
            ) : (
              <ol className="overdue-list">
                {rows.map((o) => (
                  <li key={o.loan.id} className={`b-${o.band}`}>
                    <Link href={`/loans/${o.loan.id}`}>
                      <MemberAvatar member={{ ...o.loan.member }} locale={locale} />
                      <span className="who">
                        <strong>{primaryName(o.loan.member, locale)}</strong>
                        <small className="muted">
                          {o.loan.product.code} · {t("loanNo", { no: num(o.loan.loanNo) })} · {o.loan.member.phone}
                        </small>
                      </span>
                      <span className="late-info">
                        <span className="late-chip">{t("overdue.daysLate", { count: o.daysLate, n: num(o.daysLate) })}</span>
                        <small className="muted">
                          {t("overdue.installments", { count: o.installments, n: num(o.installments) })} · {t("overdue.since", { date: formatDate(o.oldestDue, locale) })}
                        </small>
                      </span>
                      <strong className="amt">{taka(o.amount)}</strong>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
            <p className="muted small-note">{t("overdue.howFines")}</p>
          </section>
        </>
      )}
    </div>
  );
}
