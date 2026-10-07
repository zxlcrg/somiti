import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import type { ExitBlocker, ExitSettlement, ExitView } from "@/modules/members";
import { ExitDecision } from "./exit/exit-decision";

const NOTICES = ["requested", "approved", "rejected", "cancelled"] as const;
type Notice = (typeof NOTICES)[number];

export function exitNotice(value: string | undefined): Notice | undefined {
  return NOTICES.find((n) => n === value);
}

function isoDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(d);
}

export async function ExitPanel({
  memberId,
  memberName,
  memberStatus,
  exits,
  settlement,
  blockers,
  locale,
  canManage,
  userId,
  notice,
}: {
  memberId: string;
  memberName: string;
  memberStatus: "active" | "exited" | "deceased";
  exits: ExitView[];
  settlement: ExitSettlement;
  blockers: ExitBlocker[];
  locale: Locale;
  canManage: boolean;
  userId: string;
  notice?: Notice;
}) {
  const t = await getTranslations("members.exit");
  const tShares = await getTranslations("members.shares");
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const pending = exits.find((e) => e.status === "pending");
  const approved = exits.find((e) => e.status === "approved");
  const earlier = exits.filter((e) => e !== pending && e !== approved);

  // Staff who can't manage members only see a finished exit.
  if (!canManage && !approved) return null;
  if (memberStatus === "deceased" && !approved) return null;

  return (
    <section className={`exit${approved ? " done" : pending ? " waiting" : ""}`} aria-labelledby="exit-title">
      <header className="nominees-head">
        <div>
          <h2 id="exit-title">{approved ? t("exitedTitle", { name: memberName }) : pending ? t("pendingTitle") : t("title")}</h2>
          {!approved && !pending && <p className="muted">{t("intro")}</p>}
        </div>
        {!approved && !pending && canManage && memberStatus === "active" && (
          <Link href={`/members/${memberId}/exit`} className="btn ghost small danger-outline">
            ⇥ {t("start")}
          </Link>
        )}
      </header>

      {notice && (
        <p className={`celebrate small${notice === "rejected" || notice === "cancelled" ? " quiet" : ""}`} role="status">
          {t(`notices.${notice}`)}
        </p>
      )}

      {approved && (
        <>
          <p className="muted">
            {t("exitedBody", {
              who: approved.decidedBy ? primaryName(approved.decidedBy, locale) : "",
              date: formatDate(isoDay(approved.decidedAt!), locale),
            })}{" "}
            {t("reason")}: {approved.reason}
          </p>
          <div className="share-stats exit-stats">
            <div className="share-stat a">
              <span>{t("refunded")}</span>
              <strong>{taka(approved.shareRefund ?? 0n)}</strong>
            </div>
            <div className="share-stat b">
              <span>{t("paidOut")}</span>
              <strong>{taka(approved.savingsPayout ?? 0n)}</strong>
            </div>
            <div className="share-stat c">
              <span>{tShares(`methods.${approved.paymentMethod}`)}</span>
              <strong className="small-strong">
                {approved.entryNos.length ? t("receipts", { nos: approved.entryNos.map((n) => `#${num(n)}`).join(", ") }) : "—"}
              </strong>
            </div>
          </div>
        </>
      )}

      {pending && (
        <div className="exit-pending">
          <p>
            {t("pendingBody", {
              who: primaryName(pending.requestedBy, locale),
              date: formatDate(isoDay(pending.createdAt), locale),
              name: memberName,
            })}
          </p>
          <dl className="exit-facts">
            <div>
              <dt>{t("reason")}</dt>
              <dd>{pending.reason}</dd>
            </div>
            <div>
              <dt>{t("paidBy")}</dt>
              <dd>
                {tShares(`methods.${pending.paymentMethod}`)}
                {pending.paymentRef ? ` · ${pending.paymentRef}` : ""}
              </dd>
            </div>
            <div>
              <dt>{t("wouldPay")}</dt>
              <dd className="exit-total">{taka(settlement.total)}</dd>
            </div>
          </dl>
          {blockers.length > 0 && (
            <ul className="exit-blockers">
              {blockers.map((b) => (
                <li key={b}>{t(`blockers.${b}`)}</li>
              ))}
            </ul>
          )}
          {canManage && (
            <ExitDecision
              memberId={memberId}
              exitId={pending.id}
              isRequester={pending.requestedBy.id === userId}
              amountLabel={taka(settlement.total)}
            />
          )}
        </div>
      )}

      {canManage && earlier.length > 0 && (
        <details className="exit-history">
          <summary>{t("history")}</summary>
          <ul>
            {earlier.map((e) => (
              <li key={e.id}>
                <span className={`status-pill ${e.status === "rejected" ? "exited" : "deceased"}`}>{t(`statuses.${e.status}`)}</span>{" "}
                {formatDate(isoDay(e.createdAt), locale)} · {e.reason}
                {e.decisionNote ? ` — ${e.decisionNote}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
