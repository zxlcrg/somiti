import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { formatDate, formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { formatBdPhone } from "@/lib/phone";
import { canApplyForLoans, canApproveLoans, canDisburseLoans, canViewLoans, getLoan, installmentStatus, listRepayments, repaymentChannel, standing } from "@/modules/loans";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { MemberAvatar } from "../../members/member-avatar";
import { METHOD_ICON, percent, STATUS_ICON } from "../ui";
import { RepayPanel } from "./repay-panel";
import { CancelPanel, DecidePanel, DisbursePanel } from "./step-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("loans.detail");
  return { title: t("title") };
}

export default async function LoanPage({
  params,
  searchParams,
}: {
  params: Promise<{ loanId: string }>;
  searchParams: Promise<{ applied?: string; done?: string; paid?: string; closed?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("loans");
  if (!canViewLoans(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const { loanId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(loanId)) notFound();
  const search = await searchParams;
  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const l = await getLoan(ctx, loanId);
    const [somiti] = await ctx.tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
    return l ? { l, today: somiti!.d, repayments: l.disbursedOn ? await listRepayments(ctx, l.id) : [] } : null;
  });
  if (!data) notFound();
  const { l, today, repayments } = data;
  const locale = await pageLocale();
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const name = primaryName(l.member, locale);
  const charge = t(`chargeLabel.${l.product.chargeLabel}`);
  const canDecide = l.status === "applied" && canApproveLoans(user.roles) && l.appliedBy.id !== user.userId;
  const ownWaiting = l.status === "applied" && l.appliedBy.id === user.userId;
  const canPay = l.status === "approved" && canDisburseLoans(user.roles);
  const canCancel = (l.status === "applied" || l.status === "approved") && canApplyForLoans(user.roles);
  const channel = repaymentChannel(user.roles);
  const canRepay = l.status === "disbursed" && channel !== null;
  const running = l.status === "disbursed" || l.status === "closed";
  const owedTotal = l.summary.totalRepayable - l.paidPrincipal - l.paidInterest;
  const st = running ? standing(l.schedule, today) : null;
  const repaidPct = running ? Number(((l.paidPrincipal + l.paidInterest) * 1000n) / l.summary.totalRepayable) / 10 : 0;
  const paidNo = search.paid && /^\d{1,12}$/.test(search.paid) ? BigInt(search.paid) : null;
  const done = search.done && ["approve", "reject", "cancel", "disburse"].includes(search.done) ? search.done : null;

  const steps = [
    { key: "applied", on: true, who: primaryName(l.appliedBy, locale), when: formatDate(l.appliedOn, locale) },
    {
      key: l.status === "rejected" ? "rejected" : "approved",
      on: !!l.decidedBy && l.status !== "cancelled",
      who: l.decidedBy && l.status !== "cancelled" ? primaryName(l.decidedBy, locale) : null,
      when: l.decidedAt && l.status !== "cancelled" ? formatDateTime(l.decidedAt, locale) : null,
    },
    { key: "disbursed", on: !!l.disbursedOn, who: l.disbursedBy ? primaryName(l.disbursedBy, locale) : null, when: l.disbursedOn ? formatDate(l.disbursedOn, locale) : null },
    { key: "closed", on: !!l.closedOn, who: null, when: l.closedOn ? formatDate(l.closedOn, locale) : null },
  ];

  return (
    <div className="loans">
      <Link href={`/members/${l.member.id}`} className="crumb">
        ← {name}
      </Link>

      {search.applied === "1" && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">📝</span> {t("detail.appliedBanner", { no: num(l.loanNo) })}
        </p>
      )}
      {paidNo !== null && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">{search.closed === "1" ? "🎉" : "🧾"}</span>{" "}
          {search.closed === "1" ? t("detail.closedBanner", { no: num(paidNo) }) : t("detail.paidBanner", { no: num(paidNo), owed: taka(owedTotal) })}
        </p>
      )}
      {done && (
        <p className={`celebrate${done === "reject" || done === "cancel" ? " quiet" : ""}`} role="status">
          <span aria-hidden="true">{done === "disburse" ? "🎉" : done === "approve" ? "✅" : "↩️"}</span>{" "}
          {t(`detail.done.${done}`, { amount: taka(l.principal - l.processingFee), no: num(l.entryNo ?? 0n) })}
        </p>
      )}

      <section className={`loan-hero s-${l.status} m-${l.method}`}>
        <div className="loan-id">
          <MemberAvatar member={l.member} locale={locale} />
          <div>
            <span className="product-code">
              {l.product.code} · {t("loanNo", { no: num(l.loanNo) })}
            </span>
            <h1>{name}</h1>
            <p>
              {primaryName(l.product, locale)} · {percent(l.rateBp, locale)} {t(`method.${l.method}`)} · {formatBdPhone(l.member.phone)}
            </p>
          </div>
        </div>
        <div className="loan-amount">
          <span className={`status-chip s-${l.status}`}>
            <span aria-hidden="true">{STATUS_ICON[l.status]}</span> {t(`status.${l.status}`)}
          </span>
          <strong>{taka(l.principal)}</strong>
          <span>{t(`detail.over.${l.frequency}`, { n: num(l.installments), count: l.installments })}</span>
        </div>
        {running && (
          <div className="loan-progress">
            <div className="progress-track" role="img" aria-label={t("detail.repaidPct", { pct: num(Math.floor(repaidPct)) })}>
              <span style={{ width: `${repaidPct}%` }} />
            </div>
            <span>
              {t("detail.repaidOf", { paid: taka(l.paidPrincipal + l.paidInterest), total: taka(l.summary.totalRepayable) })}
              {st && st.overdueCount > 0 && (
                <strong className="overdue-note"> · {t("detail.overdueCount", { n: num(st.overdueCount), count: st.overdueCount })}</strong>
              )}
            </span>
          </div>
        )}
      </section>

      <ol className="loan-steps" aria-label={t("detail.progress")}>
        {steps.map((s) => (
          <li key={s.key} className={`${s.on ? "on" : ""} k-${s.key}`}>
            <span className="dot" aria-hidden="true">
              {s.on ? (s.key === "rejected" ? "✕" : "✓") : ""}
            </span>
            <strong>{t(`detail.step.${s.key}`)}</strong>
            {s.on && <small className="muted">{[s.who, s.when].filter(Boolean).join(" · ")}</small>}
          </li>
        ))}
      </ol>

      <div className={`loan-grid${canDecide || canPay || canRepay ? "" : " solo"}`}>
        <div className="loan-main">
          <section className="loan-card terms">
            <h2>{t("detail.terms")}</h2>
            <dl className="terms-list">
              <div>
                <dt>{t(`apply.each.${l.frequency}`)}</dt>
                <dd>
                  <strong>{taka(l.summary.installment)}</strong>
                </dd>
              </div>
              <div>
                <dt>
                  {charge} ({percent(l.rateBp, locale)})
                </dt>
                <dd>{taka(l.summary.totalInterest)}</dd>
              </div>
              <div>
                <dt>{t("apply.totalRepay")}</dt>
                <dd>{taka(l.summary.totalRepayable)}</dd>
              </div>
              <div>
                <dt>{t("detail.fee")}</dt>
                <dd>{l.processingFee ? taka(l.processingFee) : t("products.noFee")}</dd>
              </div>
              <div>
                <dt>{t("apply.handedOver")}</dt>
                <dd>{taka(l.principal - l.processingFee)}</dd>
              </div>
              <div>
                <dt>{t("detail.allocation")}</dt>
                <dd>{t(`allocation.${l.allocation}`, { charge })}</dd>
              </div>
              {l.purpose && (
                <div>
                  <dt>{t("apply.purpose")}</dt>
                  <dd>{l.purpose}</dd>
                </div>
              )}
              {l.meetingOn && (
                <div>
                  <dt>{t("detail.meeting")}</dt>
                  <dd>{formatDate(l.meetingOn, locale)}</dd>
                </div>
              )}
              {l.paymentMethod && (
                <div>
                  <dt>{t("detail.paidBy")}</dt>
                  <dd>
                    <span aria-hidden="true">{METHOD_ICON[l.paymentMethod]}</span> {t(`steps.method.${l.paymentMethod}`)}
                    {l.paymentRef ? ` · ${l.paymentRef}` : ""} · {t("detail.voucher", { no: num(l.entryNo ?? 0n) })}
                  </dd>
                </div>
              )}
              {l.decisionNote && (
                <div className="wide">
                  <dt>{t(l.status === "rejected" ? "detail.rejectReason" : l.status === "cancelled" ? "detail.cancelReason" : "detail.note")}</dt>
                  <dd>{l.decisionNote}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="loan-card">
            <h2>
              {t("detail.schedule")} {l.projected && <span className="chip">{t("detail.projected")}</span>}
            </h2>
            {l.projected && <p className="muted small-note">{t("detail.projectedNote")}</p>}
            <div className="table-wrap">
              <table className="ledger-table schedule-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>{t("schedule.due")}</th>
                    <th className="num">{t("schedule.principal")}</th>
                    <th className="num">{charge}</th>
                    <th className="num">{t("schedule.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {l.schedule.map((r) => {
                    const state = running ? installmentStatus(r, today) : null;
                    return (
                    <tr key={r.seq} className={state ? `st-${state}` : undefined}>
                      <td className="num muted">{num(r.seq)}</td>
                      <td>
                        {formatDate(r.dueOn, locale)}
                        {state && state !== "upcoming" && (
                          <span className={`inst-chip i-${state}`}>
                            {state === "part" ? t("schedule.partPaid", { amount: taka(r.paidPrincipal + r.paidInterest) }) : t(`schedule.status.${state}`)}
                          </span>
                        )}
                      </td>
                      <td className="num">{taka(r.principal)}</td>
                      <td className="num">{taka(r.interest)}</td>
                      <td className="num">
                        <strong>{taka(r.principal + r.interest)}</strong>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td />
                    <td>{t("schedule.totals")}</td>
                    <td className="num">{taka(l.principal)}</td>
                    <td className="num">{taka(l.summary.totalInterest)}</td>
                    <td className="num">
                      <strong>{taka(l.summary.totalRepayable)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {running && (
            <section className="loan-card">
              <h2>{t("history.title")}</h2>
              {repayments.length === 0 ? (
                <p className="muted">{t("history.none")}</p>
              ) : (
                <ol className="repay-list">
                  {repayments.map((r) => (
                    <li key={r.id}>
                      <span className="repay-icon" aria-hidden="true">
                        {r.channel === "collector" ? "👜" : METHOD_ICON[r.paymentMethod]}
                      </span>
                      <span className="who">
                        <strong>{taka(r.amount)}</strong>
                        <small className="muted">
                          {formatDate(r.businessDate, locale)} · {primaryName(r.createdBy, locale)} · {t("detail.voucher", { no: num(r.entryNo) })}
                          {r.paymentRef ? ` · ${r.paymentRef}` : ""}
                        </small>
                      </span>
                      <span className="repay-parts">
                        <small>
                          {r.firstSeq === r.lastSeq ? t("repay.covers.one", { n: num(r.firstSeq) }) : t("repay.covers.many", { a: num(r.firstSeq), b: num(r.lastSeq) })}
                        </small>
                        <small className="muted">
                          {t("schedule.principal")} {taka(r.principal)} · {charge} {taka(r.interest)}
                        </small>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>

        {(canDecide || canPay || ownWaiting || canCancel || canRepay) && (
          <aside className="loan-side">
            {canRepay && (
              <RepayPanel
                loanId={l.id}
                rows={l.schedule.map((r) => ({
                  seq: r.seq,
                  dueOn: r.dueOn,
                  principal: r.principal.toString(),
                  interest: r.interest.toString(),
                  paidPrincipal: r.paidPrincipal.toString(),
                  paidInterest: r.paidInterest.toString(),
                }))}
                allocation={l.allocation}
                today={today}
                channel={channel!}
                charge={charge}
              />
            )}
            {canDecide && <DecidePanel loanId={l.id} today={today} />}
            {ownWaiting && (
              <p className="notice soft">
                <span aria-hidden="true">⏳</span> {t("detail.waitingOther")}
              </p>
            )}
            {canPay && <DisbursePanel loanId={l.id} principal={l.principal.toString()} fee={l.processingFee.toString()} memberName={name} />}
            {l.status === "approved" && !canPay && (
              <p className="notice soft">
                <span aria-hidden="true">💸</span> {t("detail.waitingCashier")}
              </p>
            )}
            {canCancel && <CancelPanel loanId={l.id} needsReason={l.status === "approved"} />}
          </aside>
        )}
      </div>
    </div>
  );
}
