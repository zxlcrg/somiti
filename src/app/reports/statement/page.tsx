import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { formatBdPhone } from "@/lib/phone";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import { canViewBooks } from "@/modules/ledger";
import { getMember, listMembers } from "@/modules/members";
import { memberStatement, type StatementRow } from "@/modules/reports";
import { requireUser } from "../../auth";
import { pageLocale, voucherNo } from "../../books";
import { MemberAvatar } from "../../members/member-avatar";
import { PrintButton } from "../print-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reports.statement");
  return { title: t("title") };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StatementPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string; q?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("reports");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const search = await searchParams;
  const memberId = search.member && UUID.test(search.member) ? search.member : null;
  const q = (search.q ?? "").trim().slice(0, 60);

  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx
      .select({ businessDate: tenant.businessDate, nameEn: tenant.nameEn, nameBn: tenant.nameBn })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId));
    const today = somiti!.businessDate;
    const found = memberId ? await getMember(ctx, memberId) : null;
    if (!found) {
      const list = await listMembers(ctx, { q: q || undefined, limit: q ? 12 : 8 });
      return { today, somiti: somiti!, member: null, list: list.members, statement: null, badRange: false };
    }
    const from = search.from && ISO.test(search.from) ? search.from : found.admissionDate;
    const to = search.to && ISO.test(search.to) && search.to <= today ? search.to : today;
    const badRange = from > to;
    const statement = await memberStatement(ctx, { memberId: found.id, from: badRange ? to : from, to });
    return { today, somiti: somiti!, member: found, list: [], statement, badRange };
  });

  const taka = (p: bigint) => formatTaka(p, locale);
  const ts = (key: Parameters<typeof t>[0], values?: Record<string, string | number>) => t(key, values);

  if (!data.member || !data.statement) {
    return (
      <div className="reports">
        <header className="page-head">
          <div>
            <h1>{t("statement.title")}</h1>
            <p className="muted">{t("statement.subtitle")}</p>
          </div>
        </header>
        <section className="pick-card">
          <form action="/reports/statement" className="pick-search" role="search">
            <label htmlFor="q">{t("statement.pick")}</label>
            <div>
              <input id="q" name="q" type="search" defaultValue={q} placeholder={t("statement.searchPlaceholder")} autoFocus />
              <button className="btn primary">{t("statement.search")}</button>
            </div>
          </form>
          {q && data.list.length === 0 ? (
            <p className="muted">{t("statement.noMatch", { q })}</p>
          ) : (
            <>
              {!q && <h2 className="pick-title">{t("statement.recent")}</h2>}
              <ul className="pick-list">
                {data.list.map((m, i) => (
                  <li key={m.id} style={{ "--i": i } as React.CSSProperties}>
                    <Link href={`/reports/statement?member=${m.id}`}>
                      <MemberAvatar member={m} locale={locale} />
                      <span>
                        <strong>{primaryName(m, locale)}</strong>
                        <small className="muted">
                          #{formatInteger(m.memberNo, locale)} · {formatBdPhone(m.phone)}
                        </small>
                      </span>
                      <span className="pick-go" aria-hidden="true">
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    );
  }

  const { member, statement: s } = data;
  const name = primaryName(member, locale);
  const alt = secondaryName(member, locale);
  const signed = (v: bigint) => (v === 0n ? "" : taka(v));

  return (
    <div className="reports statement-page">
      <header className="page-head no-print">
        <div>
          <h1>{t("statement.title")}</h1>
          <p className="muted">
            <Link href="/reports/statement" className="crumb">
              ← {t("statement.change")}
            </Link>
          </p>
        </div>
        <form className="date-range" action="/reports/statement">
          <input type="hidden" name="member" value={member.id} />
          <label>
            <span>{t("from")}</span>
            <input type="date" name="from" defaultValue={s.from} max={data.today} />
          </label>
          <label>
            <span>{t("to")}</span>
            <input type="date" name="to" defaultValue={s.to} max={data.today} />
          </label>
          <button className="btn ghost small">{t("show")}</button>
          <PrintButton label={t("print")} />
        </form>
      </header>
      {data.badRange && (
        <p className="notice warn no-print" role="alert">
          {t("statement.badRange")}
        </p>
      )}

      <section className="statement-head">
        <MemberAvatar member={member} locale={locale} size="lg" />
        <div>
          <p className="muted">{t("statement.member", { no: `#${formatInteger(member.memberNo, locale)}` })}</p>
          <h2>
            <Link href={`/members/${member.id}`}>{name}</Link>
          </h2>
          {alt && <p className="muted">{alt}</p>}
          <p className="muted">{formatBdPhone(member.phone)}</p>
        </div>
        <div className="statement-period">
          <span className="statement-somiti">{primaryName(data.somiti, locale)}</span>
          <strong>{t("statement.period", { from: formatDate(s.from, locale), to: formatDate(s.to, locale) })}</strong>
          <small className="muted print-only">{t("statement.printedOn", { date: formatDate(data.today, locale) })}</small>
        </div>
      </section>

      <section className="stat-row four statement-tiles">
        <div className="stat-tile tone-a" style={{ "--i": 0 } as React.CSSProperties}>
          <span>{t("statement.tiles.savings")}</span>
          <strong className="money-figure">{taka(s.closing.savings)}</strong>
          <small>{t("statement.tiles.opening", { amount: taka(s.opening.savings) })}</small>
        </div>
        <div className="stat-tile tone-e" style={{ "--i": 1 } as React.CSSProperties}>
          <span>{t("statement.tiles.shares")}</span>
          <strong className="money-figure">{taka(s.closing.shares)}</strong>
          <small>{t("statement.tiles.opening", { amount: taka(s.opening.shares) })}</small>
        </div>
        <div className="stat-tile tone-c" style={{ "--i": 2 } as React.CSSProperties}>
          <span>{t("statement.tiles.loan")}</span>
          <strong className="money-figure">{taka(s.closing.loan)}</strong>
          <small>{t("statement.tiles.opening", { amount: taka(s.opening.loan) })}</small>
        </div>
        <div className="stat-tile tone-b" style={{ "--i": 3 } as React.CSSProperties}>
          <span>{t("statement.tiles.paid")}</span>
          <strong className="money-figure">{taka(s.totals.paidIn)}</strong>
          <small>{t("statement.tiles.paidOut", { out: taka(s.totals.paidOut), charges: taka(s.totals.charge + s.totals.fine) })}</small>
        </div>
      </section>

      <div className="table-wrap lines-card">
        <table className="ledger-table statement-table">
          <thead>
            <tr>
              <th scope="col">{t("statement.cols.date")}</th>
              <th scope="col">{t("statement.cols.voucher")}</th>
              <th scope="col">{t("statement.cols.details")}</th>
              <th scope="col" className="num">
                {t("statement.cols.paidIn")}
              </th>
              <th scope="col" className="num">
                {t("statement.cols.paidOut")}
              </th>
              <th scope="col" className="num">
                {t("statement.cols.savings")}
              </th>
              <th scope="col" className="num">
                {t("statement.cols.loan")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="carry-row">
              <td>{formatDate(s.from, locale)}</td>
              <td />
              <th scope="row">{t("statement.openingRow")}</th>
              <td />
              <td />
              <td className="num">{taka(s.opening.savings)}</td>
              <td className="num">{taka(s.opening.loan)}</td>
            </tr>
            {s.rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted empty-line">
                  {t("statement.empty")}
                </td>
              </tr>
            ) : (
              s.rows.map((r) => (
                <tr key={`${r.entryNo}-${r.kind}`} className={`k-${r.kind.split("_")[0]}${r.reversed ? " reversed" : ""}`}>
                  <td>{formatDate(r.businessDate, locale)}</td>
                  <td className="acct-code">{voucherNo(r.entryNo, locale)}</td>
                  <td>
                    <span className="kind-dot" aria-hidden="true" /> {ts(`statement.kind.${r.kind}`, { ref: r.ref, no: formatInteger(r.ref, locale) })}
                    <Detail r={r} t={t} taka={taka} />
                    {r.reversed && <span className="status-pill rejected">{t("statement.reversed")}</span>}
                  </td>
                  <td className="num debit">{signed(r.paidIn)}</td>
                  <td className="num credit">{signed(r.paidOut)}</td>
                  <td className="num">{r.savings !== 0n ? taka(r.savingsAfter) : ""}</td>
                  <td className="num">{r.loan !== 0n ? taka(r.loanAfter) : ""}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>{formatDate(s.to, locale)}</td>
              <td />
              <th scope="row">{t("statement.closingRow")}</th>
              <td className="num">{taka(s.totals.paidIn)}</td>
              <td className="num">{taka(s.totals.paidOut)}</td>
              <td className="num">{taka(s.closing.savings)}</td>
              <td className="num">{taka(s.closing.loan)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function Detail({
  r,
  t,
  taka,
}: {
  r: StatementRow;
  t: Awaited<ReturnType<typeof getTranslations<"reports">>>;
  taka: (p: bigint) => string;
}) {
  const parts: string[] = [];
  if (r.kind === "loan_repayment") parts.push(t("statement.detail.principal", { amount: taka(-r.loan) }));
  if (r.charge > 0n) parts.push(t("statement.detail.charge", { amount: taka(r.charge) }));
  if (r.fine > 0n) parts.push(t("statement.detail.fine", { amount: taka(r.fine) }));
  if (r.fee > 0n) parts.push(t("statement.detail.fee", { amount: taka(r.fee) }));
  if (r.shares !== 0n) parts.push(t("statement.detail.shares", { amount: taka(r.shares < 0n ? -r.shares : r.shares) }));
  return parts.length ? <small className="muted row-detail">{parts.join(" · ")}</small> : null;
}
