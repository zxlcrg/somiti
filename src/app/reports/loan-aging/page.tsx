import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatInteger, formatPercentBp, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewBooks } from "@/modules/ledger";
import { AGING_BANDS, loanAging, type AgingBand } from "@/modules/reports";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { PrintButton } from "../print-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reports.aging");
  return { title: t("title") };
}

const LATE_SHOWN = 50;

export default async function LoanAgingPage() {
  const user = await requireUser();
  const t = await getTranslations("reports");
  const tl = await getTranslations("loans.overdue");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const a = await withTenant(getAppDb(), user.tenantId, (ctx) => loanAging(ctx));
  const taka = (p: bigint) => formatTaka(p, locale);
  const pct = (part: bigint, whole: bigint) => formatPercentBp(whole > 0n ? Number((part * 10_000n) / whole) : 0, locale);
  const width = (part: bigint) => (a.total.principal > 0n ? `${Number((part * 1000n) / a.total.principal) / 10}%` : "0%");
  const bandLabel = (b: AgingBand) => (b === "current" ? t("aging.band.current") : tl(`band.${b}`));
  const parHigh = a.parBp >= 500;

  return (
    <div className="reports aging">
      <header className="page-head">
        <div>
          <h1>{t("aging.title")}</h1>
          <p className="muted">{t("aging.subtitle", { date: formatDate(a.today, locale) })}</p>
        </div>
        <div className="no-print">
          <PrintButton label={t("print")} />
        </div>
      </header>

      <section className="stat-row four statement-tiles">
        <div className="stat-tile tone-c" style={{ "--i": 0 } as React.CSSProperties}>
          <span>{t("aging.tiles.book")}</span>
          <strong className="money-figure">{taka(a.total.principal)}</strong>
          <small>{t("aging.tiles.bookLoans", { count: a.total.count })}</small>
        </div>
        <div className={`stat-tile ${parHigh ? "tone-d" : "tone-a"}`} style={{ "--i": 1 } as React.CSSProperties}>
          <span>{t("aging.tiles.par")}</span>
          <strong className="money-figure">{formatPercentBp(a.parBp, locale)}</strong>
          <small>{t("aging.tiles.parAmount", { amount: taka(a.atRisk) })}</small>
        </div>
        <div className="stat-tile tone-e" style={{ "--i": 2 } as React.CSSProperties}>
          <span>{t("aging.tiles.overdue")}</span>
          <strong className="money-figure">{taka(a.total.overdue)}</strong>
          <small>
            <Link href="/loans/overdue">{tl("link")} →</Link>
          </small>
        </div>
        <div className="stat-tile tone-a" style={{ "--i": 3 } as React.CSSProperties}>
          <span>{t("aging.tiles.onTime")}</span>
          <strong className="money-figure">{pct(a.bands.current.principal, a.total.principal)}</strong>
          <small>{t("aging.tiles.onTimeLoans", { count: a.bands.current.count })}</small>
        </div>
      </section>

      {a.total.count === 0 ? (
        <p className="muted empty-line">{t("aging.noLoans")}</p>
      ) : (
        <>
          <section className="aging-card">
            <h2>{t("aging.bandsTitle")}</h2>
            <div className="aging-bar" role="img" aria-label={t("aging.bandsTitle")}>
              {AGING_BANDS.filter((b) => a.bands[b].principal > 0n).map((b) => (
                <span key={b} className={`ab-${b}`} style={{ width: width(a.bands[b].principal) }} title={`${bandLabel(b)}: ${taka(a.bands[b].principal)}`} />
              ))}
            </div>
            <div className="table-wrap">
              <table className="ledger-table aging-table">
                <thead>
                  <tr>
                    <th scope="col">{t("aging.cols.age")}</th>
                    <th scope="col" className="num">
                      {t("aging.cols.loans")}
                    </th>
                    <th scope="col" className="num">
                      {t("aging.cols.principal")}
                    </th>
                    <th scope="col" className="num">
                      {t("aging.cols.share")}
                    </th>
                    <th scope="col" className="num">
                      {t("aging.cols.overdue")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {AGING_BANDS.map((b) => (
                    <tr key={b}>
                      <th scope="row">
                        <span className={`band-dot ab-${b}`} aria-hidden="true" /> {bandLabel(b)}
                      </th>
                      <td className="num">{formatInteger(a.bands[b].count, locale)}</td>
                      <td className="num">{taka(a.bands[b].principal)}</td>
                      <td className="num">{pct(a.bands[b].principal, a.total.principal)}</td>
                      <td className="num">{a.bands[b].overdue > 0n ? taka(a.bands[b].overdue) : ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{t("aging.total")}</th>
                    <td className="num">{formatInteger(a.total.count, locale)}</td>
                    <td className="num">{taka(a.total.principal)}</td>
                    <td className="num">{formatPercentBp(10_000, locale)}</td>
                    <td className="num">{taka(a.total.overdue)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="aging-card">
            <h2>{t("aging.productsTitle")}</h2>
            <div className="table-wrap">
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th scope="col">{t("aging.cols.product")}</th>
                    <th scope="col" className="num">
                      {t("aging.cols.loans")}
                    </th>
                    <th scope="col" className="num">
                      {t("aging.cols.principal")}
                    </th>
                    <th scope="col" className="num">
                      {t("aging.cols.atRisk")}
                    </th>
                    <th scope="col" className="num">
                      {t("aging.cols.par")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.products.map((p) => (
                    <tr key={p.product.id}>
                      <th scope="row">
                        <span className="acct-code">{p.product.code}</span> {primaryName({ nameEn: p.product.nameEn, nameBn: p.product.nameBn }, locale)}
                      </th>
                      <td className="num">{formatInteger(p.count, locale)}</td>
                      <td className="num">{taka(p.principal)}</td>
                      <td className="num">{p.atRisk > 0n ? taka(p.atRisk) : ""}</td>
                      <td className={`num${p.principal > 0n && p.atRisk * 20n >= p.principal ? " bad" : ""}`}>{pct(p.atRisk, p.principal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="aging-card">
            <h2>{t("aging.lateTitle")}</h2>
            {a.late.length === 0 ? (
              <p className="muted">{t("aging.noneLate")}</p>
            ) : (
              <div className="table-wrap">
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("aging.cols.loan")}</th>
                      <th scope="col">{t("aging.cols.member")}</th>
                      <th scope="col" className="num">
                        {t("aging.cols.late")}
                      </th>
                      <th scope="col" className="num">
                        {t("aging.cols.overdue")}
                      </th>
                      <th scope="col" className="num">
                        {t("aging.cols.principal")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.late.slice(0, LATE_SHOWN).map((l) => (
                      <tr key={l.loan.id}>
                        <td>
                          <Link href={`/loans/${l.loan.id}`}>
                            {l.loan.product.code} · #{formatInteger(l.loan.loanNo, locale)}
                          </Link>
                        </td>
                        <td>
                          <Link href={`/members/${l.loan.member.id}`}>
                            #{formatInteger(l.loan.member.memberNo, locale)} · {primaryName(l.loan.member, locale)}
                          </Link>
                        </td>
                        <td className="num">
                          <span className={`band-pill ab-${l.band}`}>{formatInteger(l.daysLate, locale)}</span>
                        </td>
                        <td className="num bad">{taka(l.overdue)}</td>
                        <td className="num">{taka(l.principal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <p className="muted check-how">{t("aging.how")}</p>
    </div>
  );
}
