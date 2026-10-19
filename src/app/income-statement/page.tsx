import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { addDays, addMonths, fiscalYearContaining } from "@/lib/dates";
import { formatDate, formatPercentBp, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewBooks, incomeStatement } from "@/modules/ledger";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { BooksTabs } from "../books-tabs";
import { PrintButton } from "../collection-sheet/print-button";
import { StatementSection } from "../statement-section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.statements.income");
  return { title: t("title") };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The quick periods, ending no later than the business date. */
function presets(today: string, fyStartMonth: number) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthStart = addMonths(monthStart, -1);
  const fy = fiscalYearContaining(today, fyStartMonth);
  const lastFy = fiscalYearContaining(addDays(fy.startDate, -1), fyStartMonth);
  return [
    { key: "thisMonth", from: monthStart, to: today },
    { key: "lastMonth", from: lastMonthStart, to: addDays(monthStart, -1) },
    { key: "yearToDate", from: fy.startDate, to: today },
    { key: "lastYear", from: lastFy.startDate, to: lastFy.endDate },
  ] as const;
}

export default async function IncomeStatementPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await requireUser();
  const tBooks = await getTranslations("books");
  const t = await getTranslations("books.statements");
  if (!canViewBooks(user.roles)) return <p className="notice">{tBooks("noAccess")}</p>;
  const locale = await pageLocale();
  const q = await searchParams;

  const { s, today, quick, badRange } = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx
      .select({ businessDate: tenant.businessDate, fyStart: tenant.fiscalYearStartMonth })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId));
    const today = somiti!.businessDate;
    const quick = presets(today, somiti!.fyStart);
    // Default: the fiscal year so far.
    let from: string = quick[2].from;
    let to: string = today;
    if (q.from && ISO.test(q.from)) from = q.from;
    if (q.to && ISO.test(q.to)) to = q.to > today ? today : q.to;
    const badRange = from > to;
    if (badRange) from = to;
    return { today, quick, badRange, s: await incomeStatement(ctx, { from, to }) };
  });

  const taka = (p: bigint) => formatTaka(p, locale);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const tone = s.surplus > 0n ? "surplus" : s.surplus < 0n ? "deficit" : "even";
  const bigger = s.totalIncome > s.totalExpenses ? s.totalIncome : s.totalExpenses;
  const share = (v: bigint) => (bigger > 0n ? `${Math.max(1, Number((v * 1000n) / bigger) / 10)}%` : "0%");
  const empty = s.income.length === 0 && s.expenses.length === 0;
  const somitiName = primaryName(user.somiti, locale);

  return (
    <div className="books statements">
      <header className="page-head">
        <div>
          <h1>{t("income.title")}</h1>
          <p className="muted">
            {somitiName} · {t("income.period", { from: formatDate(s.from, locale), to: formatDate(s.to, locale) })}
          </p>
        </div>
        <div className="stmt-tools no-print">
          <form className="date-range" action="/income-statement">
            <label>
              <span>{t("income.from")}</span>
              <input type="date" name="from" defaultValue={s.from} max={today} />
            </label>
            <label>
              <span>{t("income.to")}</span>
              <input type="date" name="to" defaultValue={s.to} max={today} />
            </label>
            <button className="btn ghost small">{t("show")}</button>
          </form>
          <PrintButton label={t("print")} />
        </div>
      </header>
      <div className="no-print">
        <BooksTabs active="incomeStatement" />
      </div>

      <nav className="period-chips no-print" aria-label={t("income.presets")}>
        {quick.map((p) => (
          <Link
            key={p.key}
            href={`/income-statement?from=${p.from}&to=${p.to}`}
            className="chip-btn"
            aria-current={p.from === s.from && p.to === s.to ? "true" : undefined}
          >
            {t(`income.${p.key}`)}
          </Link>
        ))}
      </nav>
      {badRange && (
        <p className="form-error" role="alert">
          {t("income.badRange")}
        </p>
      )}

      {empty ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{t("income.none")}</h2>
          <p className="muted">{t("emptyBody")}</p>
        </section>
      ) : (
        <>
          <section className={`stmt-hero result-hero is-${tone}`}>
            <div className="result-main">
              <span className="result-label">
                {tone === "deficit" ? t("income.deficit") : t("income.surplus")}
              </span>
              <strong className="money-figure result-figure">{taka(abs(s.surplus))}</strong>
              <p>
                {tone === "surplus"
                  ? t("income.surplusBody", { amount: taka(s.surplus) })
                  : tone === "deficit"
                    ? t("income.deficitBody", { amount: taka(-s.surplus) })
                    : t("income.evenBody")}
              </p>
              {tone === "surplus" && s.totalIncome > 0n && (
                <span className="margin-pill">{t("income.margin", { percent: formatPercentBp(Number((s.surplus * 10000n) / s.totalIncome), locale) })}</span>
              )}
            </div>
            <div className="versus" aria-hidden="true">
              <div className="versus-row in">
                <span>{t("income.totalIncome")}</span>
                <span className="versus-bar">
                  <span style={{ width: share(s.totalIncome) }} />
                </span>
                <strong className="money-figure">{taka(s.totalIncome)}</strong>
              </div>
              <div className="versus-row out">
                <span>{t("income.totalExpenses")}</span>
                <span className="versus-bar">
                  <span style={{ width: share(s.totalExpenses) }} />
                </span>
                <strong className="money-figure">{taka(s.totalExpenses)}</strong>
              </div>
            </div>
          </section>

          <div className="stmt-columns">
            <div className="stmt-column">
              <StatementSection
                title={t("income.income")}
                tone="income"
                lines={s.income}
                totalLabel={t("income.totalIncome")}
                total={s.totalIncome}
                noneLabel={t("income.none")}
                locale={locale}
              />
            </div>
            <div className="stmt-column">
              <StatementSection
                title={t("income.expenses")}
                tone="expense"
                lines={s.expenses}
                totalLabel={t("income.totalExpenses")}
                total={s.totalExpenses}
                noneLabel={t("income.none")}
                locale={locale}
                index={1}
              />
            </div>
          </div>
          <p className={`stmt-grand result-${tone}`}>
            <span>{tone === "deficit" ? t("income.deficit") : t("income.surplus")}</span>
            <strong className="money-figure">{taka(s.surplus)}</strong>
          </p>
        </>
      )}
    </div>
  );
}
