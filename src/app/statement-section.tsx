import type { Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import type { StatementLine } from "@/modules/ledger";

export type StatementTone = "asset" | "liability" | "equity" | "income" | "expense";

/**
 * One block of a financial statement: its accounts with a bar showing each
 * one's share of the block, then the block total.
 */
export function StatementSection({
  title,
  tone,
  lines,
  extra,
  totalLabel,
  total,
  noneLabel,
  locale,
  index = 0,
}: {
  title: string;
  tone: StatementTone;
  lines: StatementLine[];
  /** A computed row that isn't an account, e.g. the year's unclosed surplus. */
  extra?: { label: string; amount: bigint };
  totalLabel: string;
  total: bigint;
  noneLabel: string;
  locale: Locale;
  index?: number;
}) {
  const taka = (p: bigint) => formatTaka(p, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const rows = [...lines.map((l) => ({ key: l.accountId, code: l.code, name: primaryName(l, locale), alt: secondaryName(l, locale), amount: l.amount }))];
  if (extra && extra.amount !== 0n) rows.push({ key: "extra", code: "", name: extra.label, alt: null, amount: extra.amount });
  const biggest = rows.reduce((m, r) => (abs(r.amount) > m ? abs(r.amount) : m), 0n);
  const width = (v: bigint) => (biggest > 0n ? `${Math.max(2, Number((abs(v) * 1000n) / biggest) / 10)}%` : "0%");

  return (
    <section className={`stmt-block t-${tone}`} style={{ "--i": index } as React.CSSProperties} aria-label={title}>
      <h3>
        <span className={`type-dot t-${tone}`} aria-hidden="true" /> {title}
      </h3>
      {rows.length === 0 ? (
        <p className="muted stmt-none">{noneLabel}</p>
      ) : (
        <ul className="stmt-lines">
          {rows.map((r, i) => (
            <li key={r.key} className={`${r.amount < 0n ? "negative" : ""}${r.key === "extra" ? " computed" : ""}`} style={{ "--j": i } as React.CSSProperties}>
              <span className="stmt-name">
                {r.code && <span className="acct-code">{digits(r.code)}</span>}
                <span>
                  {r.name}
                  {r.alt && <small className="muted"> · {r.alt}</small>}
                </span>
              </span>
              <span className="stmt-amount">{taka(r.amount)}</span>
              <span className="stmt-bar" aria-hidden="true">
                <span style={{ width: width(r.amount) }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="stmt-total">
        <span>{totalLabel}</span>
        <strong>{taka(total)}</strong>
      </p>
    </section>
  );
}
