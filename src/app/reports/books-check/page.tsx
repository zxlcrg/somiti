import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewBooks } from "@/modules/ledger";
import { booksCheck } from "@/modules/reports";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { PrintButton } from "../print-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reports.check");
  return { title: t("title") };
}

const ICON = { savings: "💰", shares: "🧩", loans: "🤝", collectorCash: "🚲" } as const;

export default async function BooksCheckPage() {
  const user = await requireUser();
  const t = await getTranslations("reports");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const check = await withTenant(getAppDb(), user.tenantId, (ctx) => booksCheck(ctx));
  const taka = (p: bigint) => formatTaka(p, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const abs = (v: bigint) => (v < 0n ? -v : v);

  return (
    <div className="reports">
      <header className="page-head">
        <div>
          <h1>{t("check.title")}</h1>
          <p className="muted">{t("check.subtitle", { date: formatDate(check.asOf, locale) })}</p>
        </div>
        <div className="no-print">
          <PrintButton label={t("print")} />
        </div>
      </header>

      <p className={`check-verdict ${check.ok ? "ok" : "off"}`} role="status">
        <span aria-hidden="true">{check.ok ? "✅" : "⚠️"}</span> {check.ok ? t("check.allGood") : t("check.problems")}
      </p>

      <ul className="check-list">
        {check.checks.map((c, i) => {
          const diff = c.books - c.records;
          const good = diff === 0n && c.untagged === 0n && c.members.length === 0;
          return (
            <li key={c.key} className={`check-card ${good ? "ok" : "off"}`} style={{ "--i": i } as React.CSSProperties}>
              <div className="check-head">
                <span className="check-icon" aria-hidden="true">
                  {ICON[c.key]}
                </span>
                <span>
                  <strong>{t(`check.what.${c.key}`)}</strong>
                  <small className="muted">
                    {digits(c.code)} · {primaryName(c, locale)}
                  </small>
                </span>
                <span className={`status-pill ${good ? "approved" : "rejected"}`}>
                  {good ? t("check.match") : t("check.mismatch", { amount: taka(abs(diff)) })}
                </span>
              </div>
              <dl className="check-figures">
                <div>
                  <dt>{t("check.books")}</dt>
                  <dd>{taka(c.books)}</dd>
                </div>
                <div>
                  <dt>{t("check.records")}</dt>
                  <dd>{taka(c.records)}</dd>
                </div>
                <div>
                  <dt>{t("check.difference")}</dt>
                  <dd className={diff === 0n ? "zero" : "bad"}>{taka(diff)}</dd>
                </div>
              </dl>
              {c.untagged !== 0n && <p className="notice warn">{t("check.untagged", { amount: taka(c.untagged) })}</p>}
              {c.members.length > 0 && (
                <details className="check-members" open={c.members.length <= 5}>
                  <summary>{t("check.membersOff", { count: c.members.length })}</summary>
                  <table className="ledger-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("check.member")}</th>
                        <th scope="col" className="num">
                          {t("check.books")}
                        </th>
                        <th scope="col" className="num">
                          {t("check.records")}
                        </th>
                        <th scope="col" className="num">
                          {t("check.difference")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.members.map((m) => (
                        <tr key={m.memberId}>
                          <td>
                            <Link href={`/reports/statement?member=${m.memberId}`}>
                              #{formatInteger(m.memberNo, locale)} · {primaryName(m, locale)}
                            </Link>
                          </td>
                          <td className="num">{taka(m.books)}</td>
                          <td className="num">{taka(m.records)}</td>
                          <td className="num bad">{taka(m.books - m.records)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </li>
          );
        })}
      </ul>

      <p className="muted check-how">{t("check.how")}</p>
    </div>
  );
}
