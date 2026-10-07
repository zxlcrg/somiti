import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewMembers, getMember } from "@/modules/members";
import { depositChannel, getAccount } from "@/modules/savings";
import { requireUser } from "../../../auth";
import { pageLocale } from "../../../books";
import { MemberAvatar } from "../../../members/member-avatar";
import { FREQ_ICON, METHOD_ICON } from "../../ui";
import { DepositForm } from "./deposit-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.passbook");
  return { title: t("title") };
}

export default async function PassbookPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ opened?: string; deposited?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const { accountId } = await params;
  const search = await searchParams;
  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const account = await getAccount(ctx, accountId);
    if (!account) return null;
    return { account, member: (await getMember(ctx, account.memberId))! };
  });
  if (!data) notFound();
  const { account: a, member } = data;
  const locale = await pageLocale();
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const name = primaryName(member, locale);
  const productName = primaryName({ nameEn: a.productNameEn, nameBn: a.productNameBn }, locale);
  const channel = depositChannel(user.roles);
  const canDeposit = !!channel && a.status === "active" && member.status === "active";
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
          {t("passbook.deposited", { no: num(fresh.entryNo), amount: taka(fresh.amount), balance: taka(a.balance) })}
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

      <div className={`passbook-grid${canDeposit ? "" : " solo"}`}>
        <section className="passbook-history" aria-labelledby="history-title">
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
                    <tr key={x.id} className={`${x.reversed ? "reversed" : ""}${x.id === fresh?.id ? " fresh" : ""}`}>
                      <td>
                        {formatDate(x.businessDate, locale)}
                        <small className="muted">{t("passbook.receipt")} #{num(x.entryNo)}</small>
                      </td>
                      <td>
                        <span aria-hidden="true">{x.channel === "collector" ? "🚶" : METHOD_ICON[x.paymentMethod]}</span>{" "}
                        {x.channel === "collector" ? t("passbook.collector") : t(`methods.${x.paymentMethod}`)}
                        {x.paymentRef ? ` · ${x.paymentRef}` : ""}
                        {x.reversed && <span className="chip">{t("passbook.reversed")}</span>}
                        <small className="muted">
                          {t("passbook.takenBy", { name: primaryName(x.takenBy, locale) })} · {formatDateTime(x.createdAt, locale)}
                        </small>
                      </td>
                      <td className="num dep">+{taka(x.amount)}</td>
                      <td className="num">{taka(x.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {canDeposit && (
          <aside className="deposit-side">
            <DepositForm
              accountId={a.id}
              memberName={name}
              channel={channel!}
              installment={a.installment?.toString() ?? null}
              behind={(behind > 0n ? behind : 0n).toString()}
              balance={a.balance.toString()}
              minDeposit={a.minDeposit.toString()}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
