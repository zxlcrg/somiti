import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { formatDate, formatPercentBp, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { balanceSheet, canViewBooks } from "@/modules/ledger";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { BooksTabs } from "../books-tabs";
import { PrintButton } from "../collection-sheet/print-button";
import { StatementSection } from "../statement-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.statements.balanceSheet");
  return { title: t("title") };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Colours for the asset mix bar, in account-code order. */
const MIX_HUES = [158, 188, 42, 22, 265, 330, 210, 90];

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const user = await requireUser();
  const tBooks = await getTranslations("books");
  const t = await getTranslations("books.statements");
  if (!canViewBooks(user.roles)) return <p className="notice">{tBooks("noAccess")}</p>;
  const locale = await pageLocale();
  const { asOf: asked } = await searchParams;

  const { bs, today } = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
    const today = somiti!.businessDate;
    const asOf = asked && ISO.test(asked) && asked <= today ? asked : today;
    return { today, bs: await balanceSheet(ctx, asOf) };
  });

  const taka = (p: bigint) => formatTaka(p, locale);
  const balanced = bs.totalAssets === bs.totalClaims;
  const gap = bs.totalAssets - bs.totalClaims;
  const empty = bs.assets.length === 0 && bs.liabilities.length === 0 && bs.equity.length === 0 && bs.unclosedSurplus === 0n;
  const positiveAssets = bs.assets.filter((a) => a.amount > 0n);
  const mixTotal = positiveAssets.reduce((s, a) => s + a.amount, 0n);
  const somitiName = primaryName(user.somiti, locale);

  return (
    <div className="books statements">
      <header className="page-head">
        <div>
          <h1>{t("balanceSheet.title")}</h1>
          <p className="muted">
            {somitiName} · {t("balanceSheet.asOf", { date: formatDate(bs.asOf, locale) })}
          </p>
        </div>
        <div className="stmt-tools no-print">
          <form className="date-range" action="/balance-sheet">
            <label>
              <span>{t("balanceSheet.asOfLabel")}</span>
              <input type="date" name="asOf" defaultValue={bs.asOf} max={today} />
            </label>
            <button className="btn ghost small">{t("show")}</button>
          </form>
          <PrintButton label={t("print")} />
        </div>
      </header>
      <div className="no-print">
        <BooksTabs active="balanceSheet" />
      </div>

      {empty ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{t("empty")}</h2>
          <p className="muted">{t("emptyBody")}</p>
        </section>
      ) : (
        <>
          <section className={`stmt-hero ${balanced ? "is-balanced" : "is-off"}`}>
            <div className="hero-side">
              <span>{t("balanceSheet.totalAssets")}</span>
              <strong className="money-figure">{taka(bs.totalAssets)}</strong>
            </div>
            <div className="scale" aria-hidden="true">
              <svg viewBox="0 0 64 48">
                <path d="M32 6v36M14 42h36M10 14h44" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                <path d="M10 14l-7 14h14zM54 14l-7 14h14z" fill="currentColor" opacity="0.35" />
                <circle cx="32" cy="6" r="3.5" fill="currentColor" />
              </svg>
              <span className="scale-mark">{balanced ? "=" : "≠"}</span>
            </div>
            <div className="hero-side">
              <span>{t("balanceSheet.totalClaims")}</span>
              <strong className="money-figure">{taka(bs.totalClaims)}</strong>
            </div>
            <p className="hero-status" role="status">
              {balanced ? `✓ ${t("balanceSheet.balanced")}` : t("balanceSheet.notBalanced", { amount: taka(gap < 0n ? -gap : gap) })}
            </p>
          </section>

          {mixTotal > 0n && positiveAssets.length > 1 && (
            <section className="asset-mix" aria-label={t("balanceSheet.mix")}>
              <h2>{t("balanceSheet.mix")}</h2>
              <div className="mix-bar">
                {positiveAssets.map((a, i) => (
                  <span
                    key={a.accountId}
                    style={{ flexGrow: Number((a.amount * 10000n) / mixTotal), "--h": MIX_HUES[i % MIX_HUES.length] } as React.CSSProperties}
                    title={`${primaryName(a, locale)} · ${taka(a.amount)}`}
                  />
                ))}
              </div>
              <ul className="mix-legend">
                {positiveAssets.map((a, i) => (
                  <li key={a.accountId} style={{ "--h": MIX_HUES[i % MIX_HUES.length] } as React.CSSProperties}>
                    <span className="mix-dot" aria-hidden="true" />
                    {primaryName(a, locale)}
                    <strong>{formatPercentBp(Number((a.amount * 10000n) / mixTotal), locale)}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="stmt-columns">
            <div className="stmt-column">
              <h2 className="column-title">{t("balanceSheet.owns")}</h2>
              <StatementSection
                title={t("balanceSheet.assets")}
                tone="asset"
                lines={bs.assets}
                totalLabel={t("balanceSheet.totalAssets")}
                total={bs.totalAssets}
                noneLabel={t("balanceSheet.none")}
                locale={locale}
              />
            </div>
            <div className="stmt-column">
              <h2 className="column-title">{t("balanceSheet.owes")}</h2>
              <StatementSection
                title={t("balanceSheet.liabilities")}
                tone="liability"
                lines={bs.liabilities}
                totalLabel={t("balanceSheet.totalLiabilities")}
                total={bs.totalLiabilities}
                noneLabel={t("balanceSheet.none")}
                locale={locale}
                index={1}
              />
              <StatementSection
                title={t("balanceSheet.equity")}
                tone="equity"
                lines={bs.equity}
                extra={{
                  label: bs.unclosedSurplus >= 0n ? t("balanceSheet.unclosedSurplus") : t("balanceSheet.unclosedDeficit"),
                  amount: bs.unclosedSurplus,
                }}
                totalLabel={t("balanceSheet.totalEquity")}
                total={bs.totalEquity}
                noneLabel={t("balanceSheet.none")}
                locale={locale}
                index={2}
              />
              <p className="stmt-grand">
                <span>{t("balanceSheet.totalClaims")}</span>
                <strong className="money-figure">{taka(bs.totalClaims)}</strong>
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
