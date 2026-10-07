import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewMembers, getMember } from "@/modules/members";
import { canApproveWithdrawals, canRequestWithdrawals, depositChannel, getAccount, listWithdrawals } from "@/modules/savings";
import { requireUser } from "../../../auth";
import { pageLocale } from "../../../books";
import { MemberAvatar } from "../../../members/member-avatar";
import { FREQ_ICON, METHOD_ICON } from "../../ui";
import { WithdrawalCard } from "../../withdrawals/withdrawal-card";
import { DepositForm } from "./deposit-form";
import { SideTabs } from "./side-tabs";
import { WithdrawForm } from "./withdraw-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.passbook");
  return { title: t("title") };
}

export default async function PassbookPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ opened?: string; deposited?: string; requested?: string; decided?: string; kind?: string; tab?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const { accountId } = await params;
  const search = await searchParams;
  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const account = await getAccount(ctx, accountId);
    if (!account) return null;
    const withdrawals = await listWithdrawals(ctx, { accountId, limit: 20 });
    return { account, member: (await getMember(ctx, account.memberId))!, withdrawals };
  });
  if (!data) notFound();
  const { account: a, member, withdrawals } = data;
  const locale = await pageLocale();
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const name = primaryName(member, locale);
  const productName = primaryName({ nameEn: a.productNameEn, nameBn: a.productNameBn }, locale);
  const channel = depositChannel(user.roles);
  const canDeposit = !!channel && a.status === "active" && member.status === "active";
  const canWithdraw = canRequestWithdrawals(user.roles) && a.status === "active";
  const viewer = { userId: user.userId, canApprove: canApproveWithdrawals(user.roles), canRequest: canRequestWithdrawals(user.roles) };
  const pendingWd = withdrawals.filter((w) => w.status === "pending");
  const held = pendingWd.reduce((s, w) => s + w.amount, 0n);
  const requested = search.requested ? withdrawals.find((w) => w.id === search.requested) : undefined;
  const decided = search.decided ? withdrawals.find((w) => w.id === search.decided) : undefined;
  const here = `/savings/accounts/${a.id}`;
  const fresh = search.deposited ? a.transactions.find((x) => x.id === search.deposited) : undefined;
  const behind = a.due?.behind ?? 0n;
  const tone = !a.due ? "flex" : behind > 0n ? "late" : behind < 0n ? "ahead" : "ok";

  return (
    <div className="savings">
      <Link href={`/members/${member.id}`} className="crumb">
        ← {name}
      </Link>

      {search.opened === "1" && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">🎉</span> {t("openForm.opened", { no: num(a.accountNo) })}
        </p>
      )}
      {fresh && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">🎉</span>{" "}
          {fresh.fine
            ? t("fines.deposited", { no: num(fresh.entryNo), amount: taka(fresh.amount), fine: taka(fresh.fine), balance: taka(a.balance) })
            : t("passbook.deposited", { no: num(fresh.entryNo), amount: taka(fresh.amount), balance: taka(a.balance) })}
        </p>
      )}

      {requested && (
        <p className="celebrate" role="status">
          {t("withdrawals.requested", { amount: taka(requested.amount) })}
        </p>
      )}
      {decided && decided.status !== "pending" && (
        <p className={`celebrate${decided.status === "approved" ? "" : " quiet"}`} role="status">
          {decided.status === "approved"
            ? t("withdrawals.approvedBanner", { amount: taka(decided.amount), no: num(decided.entryNo ?? 0n) })
            : t(decided.status === "rejected" ? "withdrawals.rejectedBanner" : "withdrawals.cancelledBanner")}
        </p>
      )}

      <section className={`passbook-hero f-${a.frequency}`}>
        <div className="passbook-id">
          <MemberAvatar member={member} locale={locale} />
          <div>
            <span className="product-code">
              {FREQ_ICON[a.frequency]} {a.productCode} · {t("panel.accountNo", { no: num(a.accountNo) })}
            </span>
            <h1>{name}</h1>
            <p>
              {productName} · {t(`every.${a.frequency}`, { amount: a.installment ? taka(a.installment) : "" })} ·{" "}
              {t("passbook.opened", { date: formatDate(a.openedOn, locale) })}
            </p>
          </div>
        </div>
        <div className="passbook-balance">
          <span>{t("passbook.balance")}</span>
          <strong key={a.balance.toString()}>{taka(a.balance)}</strong>
          {a.due && (
            <span className={`due-chip ${tone}`}>
              {behind > 0n ? t("panel.behind", { amount: taka(behind) }) : behind < 0n ? t("panel.ahead", { amount: taka(-behind) }) : t("panel.upToDate")}
            </span>
          )}
        </div>
      </section>

      <div className={`passbook-grid${canDeposit || canWithdraw ? "" : " solo"}`}>
        <section className="passbook-history" aria-labelledby="history-title">
          {pendingWd.length > 0 && (
            <div className="wd-pending">
              <h2>
                <span aria-hidden="true">⏳</span> {t("withdrawals.waiting")}
              </h2>
              {pendingWd.map((w) => (
                <WithdrawalCard key={w.id} w={w} locale={locale} viewer={viewer} returnTo={here} />
              ))}
            </div>
          )}
          {a.due && (
            <div className="due-meter wide">
              <div className="due-head">
                <span>
                  {t("passbook.due")}: <strong>{taka(a.due.expected)}</strong>
                </span>
                <span>
                  {t("passbook.paid")}: <strong>{taka(a.due.paid)}</strong>
                </span>
              </div>
              <div className="bar">
                <div
                  className="bar-fill"
                  style={{ width: `${a.due.expected > 0n ? Math.min(100, Number((a.due.paid * 100n) / a.due.expected)) : 100}%` }}
                />
              </div>
            </div>
          )}
          <h2 id="history-title">{t("passbook.history")}</h2>
          {a.transactions.length === 0 ? (
            <p className="muted">{t("passbook.none")}</p>
          ) : (
            <div className="table-wrap">
              <table className="ledger-table passbook-table">
                <thead>
                  <tr>
                    <th>{t("passbook.date")}</th>
                    <th>{t("passbook.details")}</th>
                    <th className="num">{t("passbook.amount")}</th>
                    <th className="num">{t("passbook.runningBalance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {a.transactions.map((x) => (
                    <tr
                      key={x.id}
                      className={`${x.kind}${x.reversed ? " reversed" : ""}${x.id === fresh?.id || (decided?.entryNo != null && x.entryNo === decided.entryNo) ? " fresh" : ""}`}
                    >
                      <td>
                        {formatDate(x.businessDate, locale)}
                        <small className="muted">
                          {x.kind === "withdrawal" ? t("withdrawals.payment", { no: num(x.entryNo) }) : `${t("passbook.receipt")} #${num(x.entryNo)}`}
                        </small>
                      </td>
                      <td>
                        <span aria-hidden="true">{x.channel === "collector" ? "🚶" : METHOD_ICON[x.paymentMethod]}</span>{" "}
                        {x.kind === "withdrawal" && <strong className="wd-tag">{t("passbookExtra.withdrawal")} · </strong>}
                        {x.channel === "collector" ? t("passbook.collector") : t(`methods.${x.paymentMethod}`)}
                        {x.paymentRef ? ` · ${x.paymentRef}` : ""}
                        {x.reversed && <span className="chip">{t("passbook.reversed")}</span>}
                        <small className="muted">
                          {x.kind === "withdrawal"
                            ? t("passbookExtra.paidOutBy", { name: primaryName(x.takenBy, locale) })
                            : t("passbook.takenBy", { name: primaryName(x.takenBy, locale) })}{" "}
                          · {formatDateTime(x.createdAt, locale)}
                        </small>
                      </td>
                      <td className={`num ${x.kind === "withdrawal" ? "wdr" : "dep"}`}>
                        {x.kind === "withdrawal" ? "−" : "+"}
                        {taka(x.amount)}
                        {x.fine && <small className="fine-chip">{t("fines.chip", { amount: taka(x.fine) })}</small>}
                      </td>
                      <td className="num">{taka(x.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {(canDeposit || canWithdraw) && (
          <aside className="deposit-side">
            {(() => {
              const depositForm = canDeposit && (
                <DepositForm
                  accountId={a.id}
                  memberName={name}
                  channel={channel!}
                  installment={a.installment?.toString() ?? null}
                  behind={(behind > 0n ? behind : 0n).toString()}
                  balance={a.balance.toString()}
                  minDeposit={a.minDeposit.toString()}
                  lateFine={a.lateFine?.toString() ?? null}
                  overdue={(a.due?.overdue ?? 0n).toString()}
                  paid={a.deposited.toString()}
                />
              );
              const withdrawForm = canWithdraw && (
                <WithdrawForm accountId={a.id} memberName={name} balance={a.balance.toString()} held={held.toString()} />
              );
              if (depositForm && withdrawForm) {
                return <SideTabs key={search.tab ?? "deposit"} deposit={depositForm} withdraw={withdrawForm} start={search.tab === "withdraw" ? "withdraw" : "deposit"} />;
              }
              return depositForm || withdrawForm;
            })()}
          </aside>
        )}
      </div>
    </div>
  );
}
