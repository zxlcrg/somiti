import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import type { LoanView } from "@/modules/loans";
import { percent, STATUS_ICON } from "../../loans/ui";

/** A member's loans on their profile, newest first, with the way to apply. */
export async function LoansPanel({
  loans,
  memberId,
  memberName,
  locale,
  canApply,
}: {
  loans: LoanView[];
  memberId: string;
  memberName: string;
  locale: Locale;
  canApply: boolean;
}) {
  const t = await getTranslations("loans");
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const live = loans.filter((l) => l.status === "disbursed");
  return (
    <section className="savings-panel loans-panel" aria-labelledby="loans-title">
      <header className="nominees-head">
        <div>
          <h2 id="loans-title">{t("panel.title")}</h2>
          <p className="muted">{t("panel.subtitle", { name: memberName })}</p>
        </div>
        {live.length > 0 && <strong className="savings-total loans-total">{taka(live.reduce((s, l) => s + l.principal - l.paidPrincipal, 0n))}</strong>}
        {canApply && (
          <Link href={`/loans/apply?member=${memberId}`} className="btn primary small">
            ＋ {t("panel.apply")}
          </Link>
        )}
      </header>
      {loans.length === 0 ? (
        <p className="muted shares-empty">{t("panel.none")}</p>
      ) : (
        <div className="loan-mini-grid">
          {loans.map((l) => (
            <Link key={l.id} href={`/loans/${l.id}`} className={`loan-mini s-${l.status} m-${l.method}`}>
              <span className="loan-mini-top">
                <span className="product-code">
                  {l.product.code} · {t("loanNo", { no: num(l.loanNo) })}
                </span>
                <span className={`status-chip s-${l.status}`}>
                  <span aria-hidden="true">{STATUS_ICON[l.status]}</span> {t(`status.${l.status}`)}
                </span>
              </span>
              <strong>{taka(l.principal)}</strong>
              <small className="muted">
                {percent(l.rateBp, locale)} {t(`method.${l.method}`)} · {t(`detail.over.${l.frequency}`, { n: num(l.installments), count: l.installments })}
              </small>
              {l.status === "disbursed" && (
                <span className="mini-progress">
                  <span className="progress-track">
                    <span style={{ width: `${Number((l.paidPrincipal * 1000n) / l.principal) / 10}%` }} />
                  </span>
                  <small>{t("panel.stillOwed", { amount: taka(l.principal - l.paidPrincipal) })}</small>
                </span>
              )}
              <small className="muted">
                {l.closedOn ? t("panel.closedOn", { date: formatDate(l.closedOn, locale) }) : l.disbursedOn ? t("panel.paidOn", { date: formatDate(l.disbursedOn, locale) }) : t("panel.appliedOn", { date: formatDate(l.appliedOn, locale) })}
              </small>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
