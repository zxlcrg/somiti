import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import type { ShareHolding } from "@/modules/members";

const METHOD_ICON = { cash: "💵", bank: "🏦", mobile_wallet: "📱" } as const;

export async function SharesPanel({
  holding,
  price,
  memberId,
  memberName,
  locale,
  canBuy,
  boughtId,
}: {
  holding: ShareHolding;
  price: bigint;
  memberId: string;
  memberName: string;
  locale: Locale;
  canBuy: boolean;
  /** A purchase just made, to announce. */
  boughtId?: string;
}) {
  const t = await getTranslations("members.shares");
  const taka = (paisa: bigint) => formatTaka(paisa, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const bought = boughtId ? holding.transactions.find((x) => x.id === boughtId) : undefined;

  return (
    <section className="shares" aria-labelledby="shares-title">
      <header className="nominees-head">
        <div>
          <h2 id="shares-title">{t("title")}</h2>
          <p className="muted">{t("subtitle", { name: memberName })}</p>
        </div>
        {canBuy && (
          <Link href={`/members/${memberId}/shares/new`} className="btn primary small">
            ＋ {t("buy")}
          </Link>
        )}
      </header>

      {bought && (
        <p className="celebrate small" role="status">
          🎉 {t("bought", { no: num(bought.entryNo), count: bought.shares, amount: taka(bought.amount) })}
        </p>
      )}

      <div className="share-stats">
        <div className="share-stat a">
          <span>{t("held")}</span>
          <strong>{num(holding.shares)}</strong>
        </div>
        <div className="share-stat b">
          <span>{t("value")}</span>
          <strong>{taka(holding.amount)}</strong>
        </div>
        <div className="share-stat c">
          <span>{t("price", { price: taka(price) })}</span>
          <div className="share-coins" aria-hidden="true">
            {Array.from({ length: Math.min(holding.shares, 12) }, (_, i) => (
              <i key={i} style={{ "--i": i } as React.CSSProperties} />
            ))}
          </div>
        </div>
      </div>

      {holding.transactions.length === 0 ? (
        <p className="muted shares-empty">
          <strong>{t("none")}.</strong> {t("noneBody", { price: taka(price) })}
        </p>
      ) : (
        <>
          <h3 className="shares-history-title">{t("history")}</h3>
          <ol className="share-history">
            {holding.transactions.map((x) => (
              <li key={x.id} className={x.reversed ? "reversed" : x.id === boughtId ? "fresh" : undefined}>
                <span className="share-history-icon" aria-hidden="true">
                  {METHOD_ICON[x.paymentMethod]}
                </span>
                <div>
                  <strong>{t("count", { count: x.shares })}</strong>
                  <span className="muted">
                    {formatDate(x.businessDate, locale)} · {t(`methods.${x.paymentMethod}`)}
                    {x.paymentRef ? ` · ${x.paymentRef}` : ""} · {t("receipt", { no: num(x.entryNo) })}
                  </span>
                </div>
                <span className="share-history-amount">
                  {x.reversed && <span className="chip">{t("reversed")}</span>}
                  {taka(x.amount)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
