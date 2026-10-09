import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import type { Locale } from "@/i18n/config";
import { formatDate, formatDateTime, formatInteger, formatMonth, formatTaka, formatTakaShort } from "@/lib/format";
import { toTakaDecimal } from "@/lib/money";
import { primaryName } from "@/lib/names";
import { approvalsFor, dashboardOverview, toCollect, type ApprovalKind, type DashboardOverview } from "@/modules/dashboard";
import { canApproveVouchers, canMakeVouchers, canViewBooks } from "@/modules/ledger";
import { canApproveLoans, canDisburseLoans, canViewLoans } from "@/modules/loans";
import { canManageMembers, canViewMembers } from "@/modules/members";
import { canApproveWithdrawals, collectorBoard } from "@/modules/savings";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { MemberAvatar } from "../members/member-avatar";
import { TargetForm } from "./target-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("dashboard") };
}

const KIND_ICON: Record<ApprovalKind, string> = { loan: "📝", disburse: "💵", voucher: "🧾", withdrawal: "💸", exit: "🚪" };

/** Morning, afternoon or evening in Dhaka. */
function partOfDay(now = new Date()): "morning" | "afternoon" | "evening" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Dhaka" }).format(now));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

/** A round number just above the largest bar, so the axis reads 0, ⅓, ⅔ and the top. */
function niceTop(max: bigint): bigint {
  if (max <= 0n) return 300_00n;
  const taka = Number(max / 100n) || 1;
  const step = 10 ** Math.floor(Math.log10(taka / 3));
  const third = Math.ceil(taka / 3 / step) * step;
  return BigInt(third * 3) * 100n;
}

const pct = (part: bigint, whole: bigint) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

export default async function DashboardPage() {
  const user = await requireUser();
  const locale = await pageLocale();
  const t = await getTranslations("dashboard");
  const tRoles = await getTranslations("roles");
  const name = primaryName(user, locale);
  const somitiName = primaryName(user.somiti, locale);
  const roles = user.roles;

  if (!canViewMembers(roles))
    return (
      <div className="dash">
        <section className="dash-head">
          <div>
            <h1>{t(`greeting.${partOfDay()}`, { name })}</h1>
            <p className="muted">{somitiName}</p>
          </div>
        </section>
        <p className="notice">{t("memberSoon")}</p>
      </div>
    );

  const books = canViewBooks(roles);
  const loansOn = canViewLoans(roles);
  const counter = roles.includes("cashier") || roles.includes("field_collector");
  const collector = roles.includes("field_collector");
  const manager = canManageMembers(roles);
  const can = {
    loans: canApproveLoans(roles),
    disburse: canDisburseLoans(roles),
    vouchers: canApproveVouchers(roles),
    withdrawals: canApproveWithdrawals(roles),
    exits: manager,
  };
  const approver = Object.values(can).some(Boolean);

  const { o, due, approvals, round } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    o: await dashboardOverview(ctx),
    due: loansOn ? await toCollect(ctx, 8) : null,
    approvals: approver ? await approvalsFor(ctx, user.userId, can, 6) : null,
    round: collector ? ((await collectorBoard(ctx)).find((c) => c.userId === user.userId) ?? null) : null,
  }));
  const taka = (p: bigint) => formatTaka(p, locale);
  const short = (p: bigint) => formatTakaShort(p, locale);
  const num = (n: number) => formatInteger(n, locale);

  const toCollectCard = due && (
    <section className="dash-card collect-card" aria-labelledby="collect-title">
      <header className="card-head">
        <div>
          <h2 id="collect-title">
            <span aria-hidden="true">📋</span> {t("collect.title")}
          </h2>
          <p className="muted">{t("collect.subtitle", { date: formatDate(o.today, locale) })}</p>
        </div>
        <span className="taken-chip">
          <span aria-hidden="true">✅</span> {o.taken.count ? t("collect.taken", { count: o.taken.count, n: num(o.taken.count), amount: taka(o.taken.amount) }) : t("collect.takenNone")}
        </span>
      </header>
      {due.rows.length === 0 ? (
        <p className="dash-empty">
          <span aria-hidden="true">🌿</span> {t("collect.none")}
        </p>
      ) : (
        <>
          <ul className="collect-list">
            {due.rows.map((r) => (
              <li key={`${r.kind}-${r.id}`} className={r.paidToday ? "paid" : r.late ? "late" : "today"}>
                <Link href={r.kind === "loan" ? `/loans/${r.id}` : `/savings/accounts/${r.id}`}>
                  <MemberAvatar member={r.member} locale={locale} />
                  <span className="who">
                    <strong>{primaryName(r.member, locale)}</strong>
                    <small className="muted">
                      {r.kind === "loan" ? t("collect.loan", { no: num(r.no), code: r.productCode }) : t("collect.savings", { no: num(r.no), code: r.productCode })}
                    </small>
                  </span>
                  <span className={`due-chip ${r.paidToday ? "paid" : r.late ? "late" : "today"}`}>
                    {r.paidToday ? t("collect.paidToday") : r.kind === "savings" ? t("collect.behind") : r.late ? t("collect.lateSince", { date: formatDate(r.since!, locale) }) : t("collect.dueToday")}
                  </span>
                  <strong className="amt">{taka(r.amount)}</strong>
                  <span className="go" aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="card-foot">
            <Link href="/collection-sheet">
              {due.total > due.rows.length
                ? t("collect.more", { count: due.total - due.rows.length, n: num(due.total - due.rows.length), amount: taka(due.amount) })
                : t("collect.openSheet")}
            </Link>
          </p>
        </>
      )}
    </section>
  );

  return (
    <div className="dash">
      <section className="dash-head">
        <div>
          <p className="dash-date">
            <span aria-hidden="true">📅</span> {t("businessDate", { date: formatDate(o.today, locale) })}
          </p>
          <h1>{t(`greeting.${partOfDay()}`, { name })}</h1>
          <p className="muted">
            {somitiName} · {roles.map((r) => tRoles(r as "admin")).join(" · ")}
          </p>
        </div>
        <div className="dash-actions">
          <form action="/members" className="dash-search" role="search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4.3-4.3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input name="q" type="search" placeholder={t("search")} aria-label={t("search")} />
          </form>
          {manager && (
            <Link href="/members/new" className="btn ghost small">
              <span aria-hidden="true">＋</span> {t("actions.newMember")}
            </Link>
          )}
          {canMakeVouchers(roles) && (
            <Link href="/vouchers/new" className="btn primary small">
              <span aria-hidden="true">＋</span> {t("actions.newVoucher")}
            </Link>
          )}
        </div>
      </section>

      {round && (
        <section className="dash-card round-card">
          <div>
            <span className="label">{t("round.title")}</span>
            <strong className="round-figure">{taka(round.todayAmount)}</strong>
            <small className="muted">{round.todayCount ? t("round.today", { count: round.todayCount, n: num(round.todayCount) }) : t("round.todayNone")}</small>
          </div>
          <div>
            <span className="label">{t("round.held")}</span>
            <strong className="round-figure">{taka(round.held)}</strong>
            <small className="muted">{t("round.heldHint")}</small>
          </div>
          <Link href="/savings/collections" className="btn ghost small">
            {t("round.open")} →
          </Link>
        </section>
      )}

      <section className={`stat-grid n${(loansOn ? 4 : 2) + (books ? 2 : 0)}`} aria-label={t("statsLabel")}>
        <StatCard href="/members" tone="t-members" icon="👥" label={t("stats.members")} value={num(o.members.total)} sub={t("stats.membersSub", { n: num(o.members.newThisMonth) })} />
        <StatCard href="/savings" tone="t-savings" icon="🏦" label={t("stats.savings")} value={short(o.savings.balance)} title={taka(o.savings.balance)} sub={t("stats.savingsSub", { amount: short(o.savings.thisMonth) })} />
        {loansOn && (
          <StatCard href="/loans" tone="t-loans" icon="🤝" label={t("stats.loans")} value={short(o.loans.outstanding)} title={taka(o.loans.outstanding)} sub={t("stats.loansSub", { count: o.loans.live, n: num(o.loans.live) })} />
        )}
        {loansOn && (
          <StatCard
            href="/loans/overdue"
            tone={o.overdue.loans ? "t-late" : "t-clear"}
            icon={o.overdue.loans ? "⏰" : "🌿"}
            label={t("stats.overdue")}
            value={short(o.overdue.amount)}
            title={taka(o.overdue.amount)}
            sub={o.overdue.loans ? t("stats.overdueSub", { count: o.overdue.loans, n: num(o.overdue.loans) }) : t("stats.overdueNone")}
          />
        )}
        {books && (
          <StatCard
            href="/cash-book"
            tone="t-cash"
            icon="💰"
            label={t("stats.cash")}
            value={short(o.cash.total)}
            title={taka(o.cash.total)}
            sub={t("stats.cashSub", { hand: short(o.cash.inHand), bank: short(o.cash.bank + o.cash.wallet) })}
          />
        )}
        {books && (
          <StatCard href="/trial-balance" tone="t-shares" icon="📜" label={t("stats.shares")} value={short(o.shareCapital)} title={taka(o.shareCapital)} sub={t("stats.sharesSub")} />
        )}
      </section>

      {counter && toCollectCard}

      <div className="dash-row r-chart">
        <CollectionChart o={o} locale={locale} t={t} />
        <TargetCard o={o} locale={locale} t={t} manager={manager} />
      </div>

      <div className={`dash-row${approvals ? " r-two" : ""}`}>
        {loansOn && <PortfolioCard o={o} locale={locale} t={t} />}
        {approvals && (
          <section className="dash-card inbox-card" aria-labelledby="inbox-title">
            <header className="card-head">
              <div>
                <h2 id="inbox-title">
                  <span aria-hidden="true">📥</span> {t("inbox.title")}
                  {approvals.total > 0 && <span className="count-badge">{num(approvals.total)}</span>}
                </h2>
                <p className="muted">{t("inbox.subtitle")}</p>
              </div>
            </header>
            {approvals.items.length === 0 ? (
              <p className="dash-empty">
                <span aria-hidden="true">✨</span> {t("inbox.none")}
              </p>
            ) : (
              <ul className="inbox-list">
                {approvals.items.map((a) => (
                  <li key={`${a.kind}-${a.id}`} className={`k-${a.kind}`}>
                    <span className="kind-icon" aria-hidden="true">
                      {KIND_ICON[a.kind]}
                    </span>
                    <span className="what">
                      <span className="kind-label">{t(`inbox.kind.${a.kind}`)}</span>
                      <strong>
                        {primaryName(a, locale)}
                        {a.memberNo !== null && <small className="muted"> · {t("inbox.memberNo", { no: num(a.memberNo) })}</small>}
                      </strong>
                      <small className="muted">{t("inbox.by", { name: primaryName(a.by, locale), at: formatDateTime(a.at, locale) })}</small>
                    </span>
                    {a.amount > 0n && <strong className="amt">{taka(a.amount)}</strong>}
                    <Link href={a.href} className="btn primary small">
                      {t("inbox.review")}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {approvals.total > approvals.items.length && (
              <p className="card-foot muted">{t("inbox.more", { count: approvals.total - approvals.items.length, n: num(approvals.total - approvals.items.length) })}</p>
            )}
          </section>
        )}
      </div>

      {!counter && toCollectCard}
    </div>
  );
}

function StatCard(p: { href: string; tone: string; icon: string; label: string; value: string; sub: string; title?: string }) {
  return (
    <Link href={p.href} className={`stat-card ${p.tone}`}>
      <span className="stat-icon" aria-hidden="true">
        {p.icon}
      </span>
      <span className="stat-label">{p.label}</span>
      <strong className="stat-value" title={p.title}>
        {p.value}
      </strong>
      <small className="stat-sub">{p.sub}</small>
    </Link>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"dashboard">>>;

/** Six months of money in (savings and repayments) against loans paid out, one pair of bars a month. */
function CollectionChart({ o, locale, t }: { o: DashboardOverview; locale: Locale; t: T }) {
  const rows = o.months.map((m) => ({ ...m, collected: m.savings + m.repayments }));
  const top = niceTop(rows.reduce((mx, r) => [r.collected, r.disbursed, mx].reduce((a, b) => (b > a ? b : a)), 0n));
  const ticks = [3n, 2n, 1n, 0n].map((k) => (top * k) / 3n);
  const taka = (p: bigint) => formatTaka(p, locale);
  const empty = rows.every((r) => r.collected === 0n && r.disbursed === 0n);
  return (
    <section className="dash-card chart-card" aria-labelledby="chart-title">
      <header className="card-head">
        <div>
          <h2 id="chart-title">
            <span aria-hidden="true">📊</span> {t("chart.title")}
          </h2>
          <p className="muted">{t("chart.subtitle")}</p>
        </div>
        <ul className="chart-legend">
          <li>
            <i className="sw s-in" aria-hidden="true" /> {t("chart.collected")}
          </li>
          <li>
            <i className="sw s-out" aria-hidden="true" /> {t("chart.disbursed")}
          </li>
        </ul>
      </header>
      <div className="cv" role="img" aria-label={t("chart.aria")}>
        <div className="cv-axis" aria-hidden="true">
          {ticks.map((v) => (
            <span key={v.toString()}>{formatTakaShort(v, locale)}</span>
          ))}
        </div>
        <div className="cv-plot">
          <div className="cv-grid" aria-hidden="true">
            {ticks.map((v) => (
              <i key={v.toString()} />
            ))}
          </div>
          {rows.map((r, i) => (
            <div key={r.month} className={`cv-month${i === rows.length - 1 ? " now" : ""}${i < 2 ? " left" : i > rows.length - 3 ? " right" : ""}`} tabIndex={0}>
              <div className="cv-bars">
                <span className="bar s-in" style={{ height: `${pct(r.collected, top)}%` }} />
                <span className="bar s-out" style={{ height: `${pct(r.disbursed, top)}%` }} />
              </div>
              <span className="cv-label">{formatMonth(r.month, locale)}</span>
              <div className="cv-tip" role="tooltip">
                <strong>{formatMonth(r.month, locale, "long")}</strong>
                <span>
                  <i className="sw s-in" aria-hidden="true" /> {t("chart.collected")} <b>{taka(r.collected)}</b>
                </span>
                <small>
                  {t("chart.savings")} {taka(r.savings)} · {t("chart.repayments")} {taka(r.repayments)}
                </small>
                <span>
                  <i className="sw s-out" aria-hidden="true" /> {t("chart.disbursed")} <b>{taka(r.disbursed)}</b>
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      {empty && <p className="muted chart-empty">{t("chart.empty")}</p>}
      <div className="sr-only">
      <table>
        <caption>{t("chart.title")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("chart.month")}</th>
            <th scope="col">{t("chart.savings")}</th>
            <th scope="col">{t("chart.repayments")}</th>
            <th scope="col">{t("chart.disbursed")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <th scope="row">{formatMonth(r.month, locale, "long")}</th>
              <td>{taka(r.savings)}</td>
              <td>{taka(r.repayments)}</td>
              <td>{taka(r.disbursed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

/** This month's money in against the somiti's target. */
function TargetCard({ o, locale, t, manager }: { o: DashboardOverview; locale: Locale; t: T; manager: boolean }) {
  const now = o.months.at(-1)!;
  const collected = now.savings + now.repayments;
  const target = o.target;
  const share = target ? Math.min(100, pct(collected, target)) : 0;
  const left = target && target > collected ? target - collected : 0n;
  const [y, m] = now.month.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysLeft = lastDay - Number(o.today.slice(8, 10));
  const taka = (p: bigint) => formatTaka(p, locale);
  return (
    <section className={`dash-card target-card${target && collected >= target ? " met" : ""}`} aria-labelledby="target-title">
      <header className="card-head">
        <div>
          <h2 id="target-title">
            <span aria-hidden="true">🎯</span> {t("target.title", { month: formatMonth(now.month, locale, "long") })}
          </h2>
        </div>
      </header>
      <div className="target-body">
        <div className="ring" style={{ "--p": share } as React.CSSProperties} role="img" aria-label={target ? t("target.aria", { pct: formatInteger(Math.floor(share), locale) }) : t("target.none")}>
          <span>{target ? `${formatInteger(Math.floor(share), locale)}%` : "—"}</span>
        </div>
        <dl className="target-figures">
          <div>
            <dt>{t("target.collected")}</dt>
            <dd>{taka(collected)}</dd>
          </div>
          <div>
            <dt>{t("target.goal")}</dt>
            <dd>{target ? taka(target) : t("target.notSet")}</dd>
          </div>
          {target && (
            <div>
              <dt>{collected >= target ? t("target.met") : t("target.toGo")}</dt>
              <dd>{collected >= target ? "🎉" : taka(left)}</dd>
            </div>
          )}
        </dl>
      </div>
      <p className="muted target-note">{daysLeft ? t("target.daysLeft", { count: daysLeft, n: formatInteger(daysLeft, locale) }) : t("target.lastDay")}</p>
      {manager ? <TargetForm current={target ? toTakaDecimal(target).replace(/\.00$/, "") : ""} hasTarget={!!target} /> : !target && <p className="muted">{t("target.askManager")}</p>}
    </section>
  );
}

/** Running loans by how they stand: paying on time, an installment this week, or late. */
function PortfolioCard({ o, locale, t }: { o: DashboardOverview; locale: Locale; t: T }) {
  const p = o.portfolio;
  const total = p.onTrack.amount + p.dueSoon.amount + p.overdue.amount;
  const parts = [
    { key: "onTrack", ...p.onTrack, href: "/loans" },
    { key: "dueSoon", ...p.dueSoon, href: "/loans" },
    { key: "overdue", ...p.overdue, href: "/loans/overdue" },
  ] as const;
  const taka = (v: bigint) => formatTaka(v, locale);
  return (
    <section className="dash-card portfolio-card" aria-labelledby="portfolio-title">
      <header className="card-head">
        <div>
          <h2 id="portfolio-title">
            <span aria-hidden="true">🧭</span> {t("portfolio.title")}
          </h2>
          <p className="muted">{t("portfolio.subtitle", { count: o.loans.live, n: formatInteger(o.loans.live, locale), amount: taka(total) })}</p>
        </div>
      </header>
      {o.loans.live === 0 ? (
        <p className="dash-empty">
          <span aria-hidden="true">🌱</span> {t("portfolio.none")}
        </p>
      ) : (
        <>
          <div className="pf-bar" role="img" aria-label={t("portfolio.aria")}>
            {parts
              .filter((x) => x.amount > 0n)
              .map((x) => (
                <span key={x.key} className={`pf-${x.key}`} style={{ flexGrow: Math.max(pct(x.amount, total), 1) }} title={`${t(`portfolio.${x.key}`)} · ${taka(x.amount)}`} />
              ))}
          </div>
          <ul className="pf-legend">
            {parts.map((x) => (
              <li key={x.key}>
                <Link href={x.href} className={`pf-${x.key}`}>
                  <i className="sw" aria-hidden="true" />
                  <span>
                    <strong>{t(`portfolio.${x.key}`)}</strong>
                    <small className="muted">{t("portfolio.loans", { count: x.count, n: formatInteger(x.count, locale) })}</small>
                  </span>
                  <b>{taka(x.amount)}</b>
                  <small className="pf-share">{formatInteger(Math.round(pct(x.amount, total)), locale)}%</small>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
