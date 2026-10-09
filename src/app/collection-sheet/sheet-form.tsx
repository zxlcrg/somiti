"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatInteger, formatTaka } from "@/lib/format";
import { parseTaka, toTakaDecimal } from "@/lib/money";
import { primaryName } from "@/lib/names";
import { formatBdPhone } from "@/lib/phone";
import { MemberAvatar } from "../members/member-avatar";
import { recordSheetAction, type SheetState } from "./actions";

export interface SheetRow {
  member: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null; phone: string; photoVersion: string | null };
  lines: {
    key: string;
    kind: "savings" | "loan";
    id: string;
    no: number;
    productCode: string;
    /** Paisa as strings: bigints don't cross into the browser. */
    due: string;
    fine: string;
    late: boolean;
    paidToday: string;
    installment: string | null;
  }[];
}

type Filter = "due" | "loan" | "savings" | "all";

/** Amount in taka as a person would type it: "2200", not "2200.00". */
const plain = (p: bigint) => toTakaDecimal(p).replace(/\.00$/, "");

export function SheetForm({ rows, sheetKey, channel, locale }: { rows: SheetRow[]; sheetKey: string; channel: "office" | "collector" | null; locale: Locale }) {
  const t = useTranslations("sheet");
  const [state, action, pending] = useActionState<SheetState, FormData>(recordSheetAction, {});
  const [filter, setFilter] = useState<Filter>("due");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setConfirming(false);
  }
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const canEnter = channel !== null;

  const visible = rows
    .map((r) => ({
      ...r,
      lines: r.lines.filter((l) =>
        filter === "all" ? true : filter === "due" ? BigInt(l.due) > 0n : l.kind === filter,
      ),
    }))
    .filter((r) => r.lines.length > 0);

  const filled = Object.entries(amounts).filter(([, v]) => v.trim());
  const badKeys = new Set(filled.filter(([, v]) => !((parseTaka(v) ?? 0n) > 0n)).map(([k]) => k));
  const total = filled.reduce((s, [, v]) => s + (parseTaka(v) ?? 0n), 0n);
  const fineFor = (key: string) => {
    const line = rows.flatMap((r) => r.lines).find((l) => l.key === key);
    // The fine is only certain when the whole due is paid; show it then, as the counter would charge it.
    const typed = parseTaka(amounts[key] ?? "") ?? 0n;
    return line && typed >= BigInt(line.due) ? BigInt(line.fine) : 0n;
  };
  const fines = filled.reduce((s, [k]) => s + fineFor(k), 0n);
  const set = (key: string, v: string) => setAmounts((a) => ({ ...a, [key]: v }));
  const fillAll = () =>
    setAmounts((a) => {
      const next = { ...a };
      for (const r of visible) for (const l of r.lines) if (BigInt(l.due) > 0n && !next[l.key]?.trim()) next[l.key] = plain(BigInt(l.due));
      return next;
    });
  const counts = {
    due: rows.reduce((s, r) => s + r.lines.filter((l) => BigInt(l.due) > 0n).length, 0),
    loan: rows.reduce((s, r) => s + r.lines.filter((l) => l.kind === "loan").length, 0),
    savings: rows.reduce((s, r) => s + r.lines.filter((l) => l.kind === "savings").length, 0),
    all: rows.reduce((s, r) => s + r.lines.length, 0),
  };

  return (
    <form action={action} className="sheet-form" noValidate>
      <input type="hidden" name="sheetKey" value={sheetKey} />
      {/* Amounts on lines hidden by a filter still go with the sheet. */}
      {filled
        .filter(([k]) => !visible.some((r) => r.lines.some((l) => l.key === k)))
        .map(([k, v]) => (
          <input key={k} type="hidden" name={`line:${k}`} value={v} />
        ))}

      <div className="sheet-tools no-print">
        <nav className="seg sheet-filter" aria-label={t("filterLabel")}>
          {(["due", "loan", "savings", "all"] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? "on" : undefined} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {t(`filter.${f}`)} <span className="n">{num(counts[f])}</span>
            </button>
          ))}
        </nav>
        {canEnter && (
          <button type="button" className="btn ghost small" onClick={fillAll}>
            <span aria-hidden="true">⚡</span> {t("fillAll")}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="dash-empty no-print">
          <span aria-hidden="true">✨</span> {t("noneInFilter")}
        </p>
      ) : (
        <ol className="sheet-list">
          {visible.map((r, i) => (
            <li key={r.member.id} className="sheet-member" style={{ "--i": i } as React.CSSProperties}>
              <header>
                <Link href={`/members/${r.member.id}`} className="who">
                  <MemberAvatar member={r.member} locale={locale} />
                  <span>
                    <strong>{primaryName(r.member, locale)}</strong>
                    <small className="muted">
                      {t("memberNo", { no: num(r.member.memberNo) })} · {locale === "bn" ? toBanglaDigits(formatBdPhone(r.member.phone)) : formatBdPhone(r.member.phone)}
                    </small>
                  </span>
                </Link>
                <a href={`tel:${r.member.phone}`} className="call no-print" aria-label={t("call", { name: primaryName(r.member, locale) })}>
                  📞
                </a>
              </header>
              <ul>
                {r.lines.map((l) => {
                  const due = BigInt(l.due);
                  const fine = BigInt(l.fine);
                  const paid = BigInt(l.paidToday);
                  const err = state.errors?.[l.key];
                  const href = l.kind === "loan" ? `/loans/${l.id}` : `/savings/accounts/${l.id}`;
                  return (
                    <li key={l.key} className={`sheet-line k-${l.kind}${due === 0n ? " done" : l.late ? " late" : ""}${err || badKeys.has(l.key) ? " has-error" : ""}`}>
                      <Link href={href} className="what">
                        <span className="kind-chip">{l.kind === "loan" ? t("loan") : t("savings")}</span>
                        <strong>
                          {l.kind === "loan" ? t("loanNo", { no: num(l.no) }) : t("accountNo", { no: num(l.no) })} · {l.productCode}
                        </strong>
                        {l.installment && <small className="muted">{t("installment", { amount: taka(BigInt(l.installment)) })}</small>}
                      </Link>
                      <span className="due">
                        {due > 0n ? (
                          <>
                            <strong>{taka(due)}</strong>
                            <small className={l.late ? "late-note" : "muted"}>
                              {l.late ? t("late") : t("today")}
                              {fine > 0n && ` · ${t("fine", { amount: taka(fine) })}`}
                            </small>
                          </>
                        ) : (
                          <span className="paid-chip">✓ {t("paidUp")}</span>
                        )}
                        {paid > 0n && <small className="paid-note">{t("paidToday", { amount: taka(paid) })}</small>}
                      </span>
                      {canEnter ? (
                        <span className="take no-print">
                          <span className="money-input">
                            <span aria-hidden="true">৳</span>
                            <input
                              name={`line:${l.key}`}
                              inputMode="decimal"
                              autoComplete="off"
                              value={amounts[l.key] ?? ""}
                              onChange={(e) => set(l.key, e.target.value)}
                              placeholder={due > 0n ? plain(due) : "0"}
                              aria-label={t("amountFor", { what: `${l.kind === "loan" ? t("loanNo", { no: num(l.no) }) : t("accountNo", { no: num(l.no) })}, ${primaryName(r.member, locale)}` })}
                              aria-invalid={err || badKeys.has(l.key) ? true : undefined}
                            />
                          </span>
                          {due > 0n && !amounts[l.key]?.trim() && (
                            <button type="button" className="fill" onClick={() => set(l.key, plain(due))} title={t("fillOne")}>
                              {t("fill")}
                            </button>
                          )}
                          {(err || badKeys.has(l.key)) && (
                            <small className="field-error" role="alert">
                              {t(`errors.${err ?? "invalid_amount"}` as "errors.invalid_amount")}
                            </small>
                          )}
                        </span>
                      ) : null}
                      <span className="print-only print-blank" aria-hidden="true" />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {canEnter && (
        <div className={`sheet-bar no-print${filled.length ? " active" : ""}`}>
          <div className="bar-sum">
            <strong>{filled.length ? t("barTotal", { count: filled.length, n: num(filled.length), amount: taka(total) }) : t("barEmpty")}</strong>
            {filled.length > 0 && <small>{fines > 0n ? t("barFines", { fines: taka(fines), cash: taka(total + fines) }) : t(`barWhere.${channel}`)}</small>}
            {state.form && (
              <small className="field-error" role="alert" key={state.attempt}>
                {t(`formErrors.${state.form}`)}
              </small>
            )}
            {state.errors && Object.keys(state.errors).length > 0 && (
              <small className="field-error" role="alert" key={`l${state.attempt}`}>
                {t("lineRefused")}
              </small>
            )}
          </div>
          {confirming ? (
            <div className="bar-actions">
              <button type="button" className="btn ghost small" onClick={() => setConfirming(false)}>
                {t("back")}
              </button>
              <button className="btn primary" disabled={pending}>
                {pending ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">✓</span>} {t("confirm", { amount: taka(total + fines) })}
              </button>
            </div>
          ) : (
            <button type="button" className="btn primary" disabled={!filled.length || badKeys.size > 0} onClick={() => setConfirming(true)}>
              {filled.length ? t("record", { count: filled.length, n: num(filled.length) }) : t("recordEmpty")}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
