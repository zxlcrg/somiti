import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatTaka } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import { canViewBooks, trialBalance, type TrialBalanceRow } from "@/modules/ledger";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { BooksTabs } from "../books-tabs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ledger.trialBalance");
  return { title: t("title") };
}

const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("books");
  const tl = await getTranslations("ledger");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { asOf: asked } = await searchParams;

  const { tb, today } = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
    const today = somiti!.businessDate;
    const asOf = asked && ISO.test(asked) ? asked : today;
    return { today, tb: await trialBalance(ctx, asOf) };
  });

  const taka = (p: bigint) => formatTaka(p, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const balanced = tb.totalDebit === tb.totalCredit;
  const biggest = tb.rows.reduce((m, r) => (r.debit + r.credit > m ? r.debit + r.credit : m), 0n);
  const pct = (v: bigint) => (biggest > 0n ? `${Number((v * 1000n) / biggest) / 10}%` : "0%");
  const byType = new Map<string, TrialBalanceRow[]>();
  for (const r of tb.rows) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
  // Net per type, on its normal side: assets and expenses are debits, the rest credits.
  const net = (type: (typeof TYPES)[number]) => {
    const rows = byType.get(type) ?? [];
    const d = rows.reduce((s, r) => s + r.debit - r.credit, 0n);
    return type === "asset" || type === "expense" ? d : -d;
  };

  return (
    <div className="books">
      <header className="page-head">
        <div>
          <h1>{tl("trialBalance.title")}</h1>
          <p className="muted">{tl("trialBalance.asOf", { date: formatDate(tb.asOf, locale) })}</p>
        </div>
        <form className="date-range" action="/trial-balance">
          <label>
            <span>{t("trialBalance.asOfLabel")}</span>
            <input type="date" name="asOf" defaultValue={tb.asOf} max={today} />
          </label>
          <button className="btn ghost small">{t("cashBook.show")}</button>
        </form>
      </header>
      <BooksTabs active="trialBalance" />

      <section className="type-tiles">
        {TYPES.map((type, i) => (
          <div key={type} className={`type-tile t-${type}`} style={{ "--i": i } as React.CSSProperties}>
            <span>{tl(`accountType.${type}`)}</span>
            <strong className="money-figure">{taka(net(type))}</strong>
          </div>
        ))}
      </section>

      {tb.rows.length === 0 ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{t("trialBalance.empty")}</h2>
          <p className="muted">{t("trialBalance.emptyBody")}</p>
        </section>
      ) : (
        <div className="table-wrap lines-card">
          <table className="ledger-table tb-table">
            <thead>
              <tr>
                <th scope="col">{tl("trialBalance.code")}</th>
                <th scope="col">{tl("trialBalance.account")}</th>
                <th scope="col" className="num">
                  {tl("trialBalance.debit")}
                </th>
                <th scope="col" className="num">
                  {tl("trialBalance.credit")}
                </th>
              </tr>
            </thead>
            {TYPES.filter((type) => byType.has(type)).map((type) => (
              <tbody key={type}>
                <tr className={`group-row t-${type}`}>
                  <th scope="rowgroup" colSpan={4}>
                    <span className={`type-dot t-${type}`} aria-hidden="true" /> {tl(`accountType.${type}`)}
                  </th>
                </tr>
                {byType.get(type)!.map((r) => {
                  const alt = secondaryName(r, locale);
                  return (
                    <tr key={r.accountId}>
                      <td className="acct-code">{digits(r.code)}</td>
                      <td>
                        {primaryName(r, locale)}
                        {alt && <small className="muted"> · {alt}</small>}
                        <span className="tb-bar" aria-hidden="true">
                          <span className={r.debit > 0n ? "debit" : "credit"} style={{ width: pct(r.debit + r.credit) }} />
                        </span>
                      </td>
                      <td className="num debit">{r.debit > 0n ? taka(r.debit) : ""}</td>
                      <td className="num credit">{r.credit > 0n ? taka(r.credit) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
            <tfoot>
              <tr>
                <td />
                <th scope="row">{tl("trialBalance.total")}</th>
                <td className="num">{taka(tb.totalDebit)}</td>
                <td className="num">{taka(tb.totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
          <p className={balanced ? "balanced" : "off-by"} role="status">
            {balanced ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
            {balanced ? t("trialBalance.balanced") : t("trialBalance.notBalanced")}
          </p>
        </div>
      )}
    </div>
  );
}
