import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import type { Locale } from "@/i18n/config";
import { formatDate, formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewMembers } from "@/modules/members";
import { canManageSavings, listProducts, listWithdrawals, recentDeposits, savingsOverview, type SavingsOverview } from "@/modules/savings";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { setProductActiveAction } from "./actions";
import { FREQ_ICON } from "./ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings");
  return { title: t("title") };
}

/** Fourteen days of deposits as bars; hover or focus a bar for its day. */
async function DepositChart({ daily, locale }: { daily: SavingsOverview["daily"]; locale: Locale }) {
  const t = await getTranslations("savings.chart");
  const max = daily.reduce((m, d) => (d.amount > m ? d.amount : m), 0n);
  if (max === 0n) return <p className="muted chart-empty">{t("empty")}</p>;
  const W = 560;
  const H = 140;
  const gap = 6;
  const bw = (W - gap * (daily.length - 1)) / daily.length;
  return (
    <div className="deposit-chart">
      <svg viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label={t("title")}>
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {daily.map((d, i) => {
          const h = d.amount === 0n ? 0 : Math.max(4, Number((d.amount * BigInt(H - 8)) / max));
          const x = i * (bw + gap);
          const last = i === daily.length - 1;
          return (
            <g key={d.date} className={`bar${last ? " today" : ""}`} tabIndex={0}>
              <title>{t("tip", { date: formatDate(d.date, locale), amount: formatTaka(d.amount, locale), count: d.count })}</title>
              <rect x={x} y={0} width={bw} height={H} className="hit" />
              {h > 0 && <rect x={x} y={H - h} width={bw} height={h} rx="4" className="fill" />}
              {(i % 2 === 1 || last) && (
                <text x={x + bw / 2} y={H + 16} textAnchor="middle">
                  {formatInteger(Number(d.date.slice(8)), locale)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default async function SavingsPage({ searchParams }: { searchParams: Promise<{ created?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { created } = await searchParams;
  const { overview, products, recent, waiting } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    overview: await savingsOverview(ctx),
    products: await listProducts(ctx),
    recent: await recentDeposits(ctx),
    waiting: await listWithdrawals(ctx, { status: "pending", limit: 100 }),
  }));
  const manage = canManageSavings(user.roles);
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const fresh = created ? products.find((p) => p.id === created) : undefined;

  return (
    <div className="savings">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">{t("subtitle")}</p>
        </div>
        <div className="head-actions">
          <Link href="/savings/collections" className="btn ghost">
            <span aria-hidden="true">🚶</span> {t("collections.title")}
          </Link>
          <Link href="/savings/withdrawals" className="btn ghost">
            <span aria-hidden="true">⬆️</span> {t("withdrawals.title")}
            {waiting.length > 0 && <span className="count-badge">{num(waiting.length)}</span>}
          </Link>
          {manage && (
            <Link href="/savings/products/new" className="btn primary">
              <span aria-hidden="true">＋</span> {t("newProduct")}
            </Link>
          )}
        </div>
      </header>

      {waiting.length > 0 && (
        <Link href="/savings/withdrawals" className="wd-callout">
          <span className="wd-callout-icon" aria-hidden="true">
            ⏳
          </span>
          <span>
            <strong>{t("withdrawals.waitingCount", { count: waiting.length })}</strong>
            <small>{taka(waiting.reduce((s, w) => s + w.amount, 0n))}</small>
          </span>
          <span className="wd-callout-go">{t("withdrawals.waitingLink")} →</span>
        </Link>
      )}

      {fresh && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">🎉</span> {t("products.created", { code: fresh.code })}
        </p>
      )}

      <div className="stat-row">
        <div className="stat-tile tone-b">
          <span>{t("stats.total")}</span>
          <strong className="money-figure">{taka(overview.totalBalance)}</strong>
        </div>
        <div className="stat-tile tone-a">
          <span>{t("stats.accounts")}</span>
          <strong>{num(overview.openAccounts)}</strong>
        </div>
        <div className="stat-tile tone-c">
          <span>{t("stats.today")}</span>
          <strong className="money-figure">{taka(overview.todayAmount)}</strong>
          <small>{t("stats.todayCount", { count: overview.todayCount })}</small>
        </div>
      </div>

      <div className="savings-grid">
        <section className="savings-card">
          <h2>{t("chart.title")}</h2>
          <DepositChart daily={overview.daily} locale={locale} />
        </section>
        <section className="savings-card">
          <h2>{t("behind.title")}</h2>
          {overview.behind.length === 0 ? (
            <p className="muted all-good">
              <span aria-hidden="true">✅</span> {t("behind.none")}
            </p>
          ) : (
            <ol className="behind-list">
              {overview.behind.map((b) => (
                <li key={b.accountId}>
                  <Link href={`/savings/accounts/${b.accountId}`}>
                    <span className="who">
                      <strong>{primaryName(b, locale)}</strong>
                      <small className="muted">
                        #{num(b.memberNo)} · {b.productCode}
                      </small>
                    </span>
                    <span className="late">{t("behind.by", { amount: taka(b.behind) })}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <h2 className="section-title">{t("products.title")}</h2>
      {products.length === 0 ? (
        <div className="empty">
          <strong>{t("products.none")}</strong>
          <p>{t("products.noneBody")}</p>
          {manage && (
            <Link href="/savings/products/new" className="btn primary small">
              ＋ {t("newProduct")}
            </Link>
          )}
        </div>
      ) : (
        <div className="product-grid">
          {products.map((p, i) => (
            <article key={p.id} className={`product-card f-${p.frequency}${p.active ? "" : " off"}`} style={{ "--i": i } as React.CSSProperties}>
              <header>
                <span className="product-icon" aria-hidden="true">
                  {FREQ_ICON[p.frequency]}
                </span>
                <span className="product-code">{p.code}</span>
                <span className="freq-pill">{t(`frequency.${p.frequency}`)}</span>
              </header>
              <h3>{primaryName(p, locale)}</h3>
              <p className="product-rule">{t(`every.${p.frequency}`, { amount: p.installment ? taka(p.installment) : "" })}</p>
              <dl>
                <div>
                  <dt>{t("panel.balance")}</dt>
                  <dd>{taka(p.balance)}</dd>
                </div>
                <div>
                  <dt>{t("stats.accounts")}</dt>
                  <dd>{num(p.openAccounts)}</dd>
                </div>
              </dl>
              <footer>
                <small className="muted">{t("products.minDeposit", { amount: taka(p.minDeposit) })}</small>
                {!p.active && <span className="chip">{t("products.off")}</span>}
                {manage && (
                  <form action={setProductActiveAction.bind(null, p.id, !p.active)}>
                    <button className="link">{p.active ? t("products.turnOff") : t("products.turnOn")}</button>
                  </form>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}

      <h2 className="section-title">{t("recent.title")}</h2>
      {recent.length === 0 ? (
        <p className="muted">{t("recent.none")}</p>
      ) : (
        <ol className="recent-deposits">
          {recent.map((r) => (
            <li key={r.id}>
              <Link href={`/savings/accounts/${r.accountId}`}>
                <span className="dep-icon" aria-hidden="true">
                  {r.channel === "collector" ? "🚶" : r.paymentMethod === "bank" ? "🏦" : r.paymentMethod === "mobile_wallet" ? "📱" : "💵"}
                </span>
                <span className="who">
                  <strong>{primaryName(r, locale)}</strong>
                  <small className="muted">
                    #{num(r.memberNo)} · {t("panel.accountNo", { no: num(r.accountNo) })} · {formatDateTime(r.createdAt, locale)}
                    {r.channel === "collector" ? ` · ${t("recent.collector")}` : ""}
                  </small>
                </span>
                <strong className="dep-amount">+{taka(r.amount)}</strong>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
