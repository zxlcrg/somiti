import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import {
  canApproveLoans,
  canDisburseLoans,
  canManageLoanProducts,
  canViewLoans,
  listLoanProducts,
  listLoans,
  loanStats,
  type LoanView,
} from "@/modules/loans";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { MemberAvatar } from "../members/member-avatar";
import { setLoanProductActiveAction } from "./actions";
import { PayoutChart, percent, STATUS_ICON } from "./ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("loans");
  return { title: t("title") };
}

export default async function LoansPage({ searchParams }: { searchParams: Promise<{ created?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("loans");
  if (!canViewLoans(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { created } = await searchParams;
  const { stats, products, applied, approved, recent } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    stats: await loanStats(ctx),
    products: await listLoanProducts(ctx),
    applied: await listLoans(ctx, { status: "applied" }),
    approved: await listLoans(ctx, { status: "approved" }),
    recent: await listLoans(ctx, { status: ["disbursed", "closed", "rejected", "cancelled"], limit: 12 }),
  }));
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const manage = canManageLoanProducts(user.roles);
  const fresh = created ? products.find((p) => p.id === created) : undefined;
  const mine = (l: LoanView) => l.appliedBy.id === user.userId;
  const decide = canApproveLoans(user.roles) ? applied.filter((l) => !mine(l)).length : 0;
  const pay = canDisburseLoans(user.roles) ? approved.length : 0;

  const queue = (title: string, icon: string, rows: LoanView[], hint: (l: LoanView) => string, tone: string) => (
    <section className={`loan-card queue ${tone}`}>
      <h2>
        <span aria-hidden="true">{icon}</span> {title}
        {rows.length > 0 && <span className="count-badge">{num(rows.length)}</span>}
      </h2>
      {rows.length === 0 ? (
        <p className="muted all-good">
          <span aria-hidden="true">✨</span> {t("queue.none")}
        </p>
      ) : (
        <ol className="loan-list">
          {rows.map((l) => (
            <li key={l.id}>
              <Link href={`/loans/${l.id}`}>
                <MemberAvatar member={{ ...l.member }} locale={locale} />
                <span className="who">
                  <strong>{primaryName(l.member, locale)}</strong>
                  <small className="muted">
                    {l.product.code} · {t("loanNo", { no: num(l.loanNo) })} · {hint(l)}
                  </small>
                </span>
                <strong className="amt">{taka(l.principal)}</strong>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  return (
    <div className="loans">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">{t("subtitle")}</p>
        </div>
        <div className="head-actions">
          {manage && (
            <Link href="/loans/products/new" className="btn primary">
              <span aria-hidden="true">＋</span> {t("newProduct")}
            </Link>
          )}
        </div>
      </header>

      {fresh && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">🎉</span> {t("products.created", { code: fresh.code })}
        </p>
      )}

      {(decide > 0 || pay > 0) && (
        <div className="loan-callouts">
          {decide > 0 && (
            <a href="#decide" className="wd-callout">
              <span className="wd-callout-icon" aria-hidden="true">
                📝
              </span>
              <span>
                <strong>{t("callout.decide", { count: decide, n: num(decide) })}</strong>
              </span>
              <span className="wd-callout-go">{t("callout.go")} →</span>
            </a>
          )}
          {pay > 0 && (
            <a href="#pay" className="wd-callout pay">
              <span className="wd-callout-icon" aria-hidden="true">
                💸
              </span>
              <span>
                <strong>{t("callout.pay", { count: pay, n: num(pay) })}</strong>
                <small>{taka(approved.reduce((s, l) => s + l.principal - l.processingFee, 0n))}</small>
              </span>
              <span className="wd-callout-go">{t("callout.go")} →</span>
            </a>
          )}
        </div>
      )}

      <div className="stat-row loan-stats">
        <div className="stat-tile tone-b">
          <span>{t("stats.outstanding")}</span>
          <strong className="money-figure">{taka(stats.outstandingPrincipal)}</strong>
        </div>
        <div className="stat-tile tone-a">
          <span>{t("stats.live")}</span>
          <strong>{num(stats.live)}</strong>
        </div>
        <div className="stat-tile tone-c">
          <span>{t("stats.waiting")}</span>
          <strong>{num(stats.applied + stats.approved)}</strong>
          <small>{t("stats.waitingSplit", { applied: num(stats.applied), approved: num(stats.approved) })}</small>
        </div>
      </div>

      <div className="loans-grid">
        <section className="loan-card">
          <h2>{t("chart.title")}</h2>
          <PayoutChart monthly={stats.monthly} locale={locale} />
        </section>
        <div className="queues">
          <div id="decide">
            {queue(t("queue.decide"), "📝", applied, (l) => t("queue.appliedOn", { date: formatDate(l.appliedOn, locale) }), "q-decide")}
          </div>
          <div id="pay">
            {queue(t("queue.pay"), "💸", approved, (l) => t("queue.handOver", { amount: taka(l.principal - l.processingFee) }), "q-pay")}
          </div>
        </div>
      </div>

      <section className="loan-card">
        <h2>{t("products.title")}</h2>
        {products.length === 0 ? (
          <div className="empty-inline">
            <p className="muted">{t("products.none")}</p>
            {manage && (
              <Link href="/loans/products/new" className="btn primary small">
                {t("newProduct")}
              </Link>
            )}
          </div>
        ) : (
          <div className="loan-products">
            {products.map((p) => (
              <article key={p.id} className={`loan-product m-${p.method}${p.active ? "" : " off"}`}>
                <header>
                  <span className="product-code">{p.code}</span>
                  <span className={`chip method-${p.method}`}>{t(`method.${p.method}`)}</span>
                  {!p.active && <span className="chip">{t("products.off")}</span>}
                </header>
                <h3>{primaryName(p, locale)}</h3>
                <p className="rate">
                  <strong>{percent(p.rateBp, locale)}</strong> {t(`products.perYear.${p.chargeLabel}`)}
                </p>
                <dl>
                  <div>
                    <dt>{t("products.repaid")}</dt>
                    <dd>{t(`frequency.${p.frequency}`)}</dd>
                  </div>
                  <div>
                    <dt>{t("products.range")}</dt>
                    <dd>
                      {taka(p.minAmount)} – {taka(p.maxAmount)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("products.term")}</dt>
                    <dd>{t(`products.upTo.${p.frequency}`, { n: num(p.maxInstallments), count: p.maxInstallments })}</dd>
                  </div>
                  <div>
                    <dt>{t("products.fee")}</dt>
                    <dd>{p.processingFeeBp ? percent(p.processingFeeBp, locale) : t("products.noFee")}</dd>
                  </div>
                </dl>
                <footer>
                  <span className="muted">
                    {t("products.live", { count: p.liveLoans, n: num(p.liveLoans) })} · {taka(p.disbursed)}
                  </span>
                  {manage && (
                    <form action={setLoanProductActiveAction.bind(null, p.id, !p.active)}>
                      <button className="btn ghost small">{p.active ? t("products.switchOff") : t("products.switchOn")}</button>
                    </form>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="loan-card">
        <h2>{t("recent.title")}</h2>
        {recent.length === 0 ? (
          <p className="muted">{t("recent.none")}</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger-table loan-table">
              <thead>
                <tr>
                  <th>{t("recent.loan")}</th>
                  <th>{t("recent.member")}</th>
                  <th>{t("recent.status")}</th>
                  <th className="num">{t("recent.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link href={`/loans/${l.id}`}>
                        {l.product.code} · {t("loanNo", { no: num(l.loanNo) })}
                      </Link>
                    </td>
                    <td>{primaryName(l.member, locale)}</td>
                    <td>
                      <span className={`status-chip s-${l.status}`}>
                        <span aria-hidden="true">{STATUS_ICON[l.status]}</span> {t(`status.${l.status}`)}
                      </span>
                    </td>
                    <td className="num">{taka(l.principal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small-note">{t("recent.howToApply")}</p>
      </section>
    </div>
  );
}
