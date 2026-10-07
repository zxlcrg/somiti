import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatInteger, formatTaka } from "@/lib/format";
import type { LoanStats } from "@/modules/loans";

export { METHOD_ICON, STATUS_ICON } from "./ui-client";

/** "12%" or "12.5%", in the page's digits. */
export function percent(bp: number, locale: Locale): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  const text = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
  return `${locale === "bn" ? text.replace(/[0-9]/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]!) : text}%`;
}

/** Six months of payouts as bars; hover or focus one for its month. */
export async function PayoutChart({ monthly, locale }: { monthly: LoanStats["monthly"]; locale: Locale }) {
  const t = await getTranslations("loans.chart");
  const max = monthly.reduce((m, d) => (d.amount > m ? d.amount : m), 0n);
  if (max === 0n) return <p className="muted chart-empty">{t("empty")}</p>;
  const W = 480;
  const H = 150;
  const gap = 18;
  const bw = (W - gap * (monthly.length - 1)) / monthly.length;
  const monthName = (m: string) => new Intl.DateTimeFormat(locale === "bn" ? "bn-BD" : "en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
  return (
    <div className="payout-chart">
      <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label={t("title")}>
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {monthly.map((d, i) => {
          const h = d.amount === 0n ? 0 : Math.max(4, Number((d.amount * BigInt(H - 26)) / max));
          const x = i * (bw + gap);
          return (
            <g key={d.month} className={`bar${i === monthly.length - 1 ? " now" : ""}`} tabIndex={0}>
              <title>{t("tip", { month: monthName(d.month), amount: formatTaka(d.amount, locale), count: d.count })}</title>
              <rect x={x} y={0} width={bw} height={H} className="hit" />
              {h > 0 && <rect x={x} y={H - h} width={bw} height={h} rx="4" className="fill" />}
              {d.count > 0 && (
                <text x={x + bw / 2} y={H - h - 6} textAnchor="middle" className="value">
                  {formatInteger(d.count, locale)}
                </text>
              )}
              <text x={x + bw / 2} y={H + 17} textAnchor="middle">
                {monthName(d.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="muted chart-note">{t("note")}</p>
    </div>
  );
}
