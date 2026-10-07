import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import type { WithdrawalView } from "@/modules/savings";
import { METHOD_ICON } from "../ui";
import { WithdrawalDecision } from "./decision";

/**
 * One withdrawal request: who, how much, how it is paid and why, with the
 * decision buttons this viewer may use. `showMember` adds the member and
 * account, for lists that span accounts.
 */
export async function WithdrawalCard({
  w,
  locale,
  viewer,
  returnTo,
  showMember = false,
}: {
  w: WithdrawalView;
  locale: Locale;
  viewer: { userId: string; canApprove: boolean; canRequest: boolean };
  returnTo: string;
  showMember?: boolean;
}) {
  const t = await getTranslations("savings");
  const taka = (p: bigint) => formatTaka(p, locale);
  const mine = w.requestedBy.id === viewer.userId;
  const mode = w.status !== "pending" ? null : mine ? (viewer.canRequest ? "maker" : null) : viewer.canApprove ? "checker" : null;

  return (
    <article className={`wd-card ${w.status}`}>
      <div className="wd-top">
        <span className="wd-icon" aria-hidden="true">
          {METHOD_ICON[w.paymentMethod]}
        </span>
        <div className="wd-main">
          {showMember && (
            <Link href={`/savings/accounts/${w.accountId}`} className="wd-member">
              {primaryName({ nameEn: w.memberNameEn, nameBn: w.memberNameBn }, locale)}
              <small className="muted">
                {" "}
                #{formatInteger(w.memberNo, locale)} · {w.productCode} · {t("withdrawals.account", { no: formatInteger(w.accountNo, locale) })}
              </small>
            </Link>
          )}
          <span className="wd-how">
            {t(`methods.${w.paymentMethod}`)}
            {w.paymentRef ? ` · ${w.paymentRef}` : ""}
          </span>
          {w.reason && <q className="wd-reason">{w.reason}</q>}
          <small className="muted">
            {t("withdrawals.requestedBy", { name: primaryName(w.requestedBy, locale), time: formatDateTime(w.createdAt, locale) })}
          </small>
        </div>
        <div className="wd-amount">
          <strong>−{taka(w.amount)}</strong>
          <span className={`wd-status ${w.status}`}>{t(`withdrawals.status.${w.status}`)}</span>
        </div>
      </div>

      {w.status !== "pending" && w.decidedBy && (
        <p className="wd-outcome muted">
          {t(`withdrawals.decided.${w.status}`, { name: primaryName(w.decidedBy, locale) })}
          {w.decidedAt ? ` · ${formatDateTime(w.decidedAt, locale)}` : ""}
          {w.entryNo !== null ? ` · ${t("withdrawals.payment", { no: formatInteger(w.entryNo, locale) })}` : ""}
          {w.decisionNote ? ` · “${w.decisionNote}”` : ""}
        </p>
      )}
      {w.status === "pending" &&
        (mode ? (
          <>
            {mode === "maker" && <p className="wd-outcome muted">{t("withdrawals.yours")}</p>}
            <WithdrawalDecision withdrawalId={w.id} returnTo={returnTo} mode={mode} />
          </>
        ) : (
          <p className="wd-outcome muted">{mine ? t("withdrawals.yours") : t("withdrawals.notYours")}</p>
        ))}
    </article>
  );
}
