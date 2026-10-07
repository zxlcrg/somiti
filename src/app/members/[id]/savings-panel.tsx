import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import type { SavingsAccountView } from "@/modules/savings";
import { FREQ_ICON } from "../../savings/ui";

/** Paid against due so far, as a 0–100 fill. Paid ahead fills it. */
function progress(a: SavingsAccountView): number {
  if (!a.due || a.due.expected === 0n) return 100;
  const pct = Number((a.due.paid * 100n) / a.due.expected);
  return Math.max(0, Math.min(100, pct));
}

export async function SavingsPanel({
  accounts,
  memberId,
  memberName,
  locale,
  canOpen,
  canDeposit,
  hasProducts,
}: {
  accounts: SavingsAccountView[];
  memberId: string;
  memberName: string;
  locale: Locale;
  canOpen: boolean;
  canDeposit: boolean;
  hasProducts: boolean;
}) {
  const t = await getTranslations("savings");
  const taka = (p: bigint) => formatTaka(p, locale);
  const total = accounts.reduce((s, a) => s + a.balance, 0n);

  return (
    <section className="savings-panel" aria-labelledby="savings-title">
      <header className="nominees-head">
        <div>
          <h2 id="savings-title">{t("panel.title")}</h2>
          <p className="muted">{t("panel.subtitle", { name: memberName })}</p>
        </div>
        {accounts.length > 0 && <strong className="savings-total">{taka(total)}</strong>}
        {canOpen && hasProducts && (
          <Link href={`/members/${memberId}/savings/new`} className="btn primary small">
            ＋ {t("panel.open")}
          </Link>
        )}
      </header>

      {accounts.length === 0 ? (
        <p className="muted shares-empty">
          <strong>{t("panel.none")}.</strong> {hasProducts ? t("panel.noneBody") : t("panel.noProducts")}
        </p>
      ) : (
        <div className="account-cards">
          {accounts.map((a, i) => {
            const behind = a.due?.behind ?? 0n;
            const tone = !a.due ? "flex" : behind > 0n ? "late" : behind < 0n ? "ahead" : "ok";
            return (
              <article key={a.id} className={`account-card f-${a.frequency} ${tone}${a.status === "closed" ? " closed" : ""}`} style={{ "--i": i } as React.CSSProperties}>
                <header>
                  <span className="product-icon" aria-hidden="true">
                    {FREQ_ICON[a.frequency]}
                  </span>
                  <div>
                    <strong>{primaryName({ nameEn: a.productNameEn, nameBn: a.productNameBn }, locale)}</strong>
                    <small className="muted">
                      {t("panel.accountNo", { no: formatInteger(a.accountNo, locale) })} ·{" "}
                      {t(`every.${a.frequency}`, { amount: a.installment ? taka(a.installment) : "" })}
                    </small>
                  </div>
                </header>
                <div className="account-balance">
                  <span>{t("panel.balance")}</span>
                  <strong>{taka(a.balance)}</strong>
                </div>
                {a.status === "closed" ? (
                  <span className="chip">{t("panel.closed")}</span>
                ) : (
                  a.due && (
                    <div className="due-meter">
                      <div className="due-head">
                        <span className={`due-chip ${tone}`}>
                          {behind > 0n ? t("panel.behind", { amount: taka(behind) }) : behind < 0n ? t("panel.ahead", { amount: taka(-behind) }) : t("panel.upToDate")}
                        </span>
                        <small className="muted">{t("panel.paidOf", { paid: taka(a.due.paid), expected: taka(a.due.expected) })}</small>
                      </div>
                      <div className="bar">
                        <div className="bar-fill" style={{ width: `${progress(a)}%` }} />
                      </div>
                    </div>
                  )
                )}
                <footer>
                  <small className="muted">
                    {a.lastDepositOn ? t("panel.lastDeposit", { date: formatDate(a.lastDepositOn, locale) }) : t("panel.noDeposits")}
                  </small>
                  <span className="account-actions">
                    <Link href={`/savings/accounts/${a.id}`} className="btn ghost small">
                      {t("panel.passbook")}
                    </Link>
                    {canDeposit && a.status === "active" && (
                      <Link href={`/savings/accounts/${a.id}#deposit`} className="btn primary small">
                        ＋ {t("panel.deposit")}
                      </Link>
                    )}
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
