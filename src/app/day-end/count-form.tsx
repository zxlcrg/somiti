"use client";

import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits, toLatinDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { DENOMINATIONS } from "@/modules/dayend/count";
import { closeDayAction, type CloseDayState } from "./actions";

/** The cashier's drawer count: pieces per note, a live total against the books, then a confirmed close. */
export function CountForm({ date, dateLabel, nextLabel, expected }: { date: string; dateLabel: string; nextLabel: string; expected: string }) {
  const t = useTranslations("books.dayEnd");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<CloseDayState, FormData>(closeDayAction.bind(null, date), {});
  const [pieces, setPieces] = useState<Record<string, string>>({});
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setConfirming(false);
  }
  const taka = (p: bigint) => formatTaka(p, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const n = (d: number) => {
    const text = toLatinDigits(pieces[String(d)] ?? "").trim();
    return /^\d+$/.test(text) ? BigInt(text) : 0n;
  };
  const set = (d: number, value: string) => setPieces((prev) => ({ ...prev, [String(d)]: value }));
  const step = (d: number, by: number) => {
    const next = n(d) + BigInt(by);
    set(d, next > 0n ? digits(next.toString()) : "");
  };

  const loose = parseTaka(other) ?? 0n;
  const counted = DENOMINATIONS.reduce((sum, d) => sum + BigInt(d) * 100n * n(d), loose > 0n ? loose : 0n);
  const books = BigInt(expected);
  const diff = counted - books;
  const abs = diff < 0n ? -diff : diff;
  const tone = diff === 0n ? "match" : diff < 0n ? "short" : "over";
  // Until something is counted, a "short by everything" warning is noise.
  const started = other.trim() !== "" || Object.values(pieces).some((v) => v.trim() !== "");
  const e = state.errors ?? {};
  const fieldError = (f: "pieces" | "other" | "note") => (e[f] ? t(`errors.${e[f]}`) : undefined);

  return (
    <form
      className="count-form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!confirming) {
          setConfirming(true);
          return;
        }
        const data = new FormData(ev.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <div className="count-card">
        <h2>{t("countTitle")}</h2>
        <div className="denom-head" aria-hidden="true">
          <span>{t("note")}</span>
          <span>{t("pieces")}</span>
          <span>{t("subtotal")}</span>
        </div>
        <ul className="denoms">
          {DENOMINATIONS.map((d) => {
            const sub = BigInt(d) * 100n * n(d);
            return (
              <li key={d} className={sub > 0n ? "has" : undefined}>
                <label htmlFor={`n${d}`} className={`note-chip n${d}`}>
                  ৳{digits(String(d))}
                </label>
                <span className="denom-stepper">
                  <button type="button" onClick={() => step(d, -1)} aria-label={`− ৳${d}`} tabIndex={-1}>
                    −
                  </button>
                  <input
                    id={`n${d}`}
                    name={`n${d}`}
                    inputMode="numeric"
                    autoComplete="off"
                    value={pieces[String(d)] ?? ""}
                    placeholder={digits("0")}
                    onChange={(ev) => set(d, ev.target.value)}
                    onFocus={(ev) => ev.target.select()}
                  />
                  <button type="button" onClick={() => step(d, 1)} aria-label={`+ ৳${d}`} tabIndex={-1}>
                    +
                  </button>
                </span>
                <span className="sub">{sub > 0n ? taka(sub) : "—"}</span>
              </li>
            );
          })}
        </ul>
        {fieldError("pieces") && <small className="field-error">{fieldError("pieces")}</small>}
        <div className={`field loose${fieldError("other") ? " has-error" : ""}`}>
          <label htmlFor="other">{t("other")}</label>
          <span className="money-input">
            <span aria-hidden="true">৳</span>
            <input id="other" name="other" inputMode="decimal" autoComplete="off" value={other} onChange={(ev) => setOther(ev.target.value)} placeholder={digits("0")} />
          </span>
          {fieldError("other") ? <small className="field-error">{fieldError("other")}</small> : <small>{t("otherHint")}</small>}
        </div>
      </div>

      <aside className={`tally-card ${tone}`} aria-live="polite">
        <div className="tally-row">
          <span>{t("expected")}</span>
          <strong>{taka(books)}</strong>
        </div>
        <div className="tally-row big">
          <span>{t("counted")}</span>
          <strong>{taka(counted)}</strong>
        </div>
        {started || diff === 0n ? (
          <p className={`tally-verdict ${tone}`}>
            <span aria-hidden="true">{tone === "match" ? "✓" : tone === "short" ? "▼" : "▲"}</span>{" "}
            {tone === "match" ? t("match") : t(tone, { amount: taka(abs) })}
          </p>
        ) : (
          <p className="tally-verdict waiting">{t("waiting")}</p>
        )}

        {diff !== 0n && (started || e.note) && (
          <>
            <div className={`field${fieldError("note") ? " has-error" : ""}`}>
              <label htmlFor="note">{t("reason")}</label>
              <textarea id="note" name="note" rows={2} maxLength={300} value={note} onChange={(ev) => setNote(ev.target.value)} />
              {fieldError("note") ? <small className="field-error">{fieldError("note")}</small> : <small>{t("reasonHint")}</small>}
            </div>
            <div className="entry-preview mini">
              <span className="label">{t("preview")}</span>
              <div className="entry-row">
                <span className="side dr">{t("debit")}</span>
                <span className="account">{diff < 0n ? t("overShort") : t("cashInHand")}</span>
                <strong>{taka(abs)}</strong>
              </div>
              <div className="entry-row">
                <span className="side cr">{t("credit")}</span>
                <span className="account">{diff < 0n ? t("cashInHand") : t("overShort")}</span>
                <strong>{taka(abs)}</strong>
              </div>
            </div>
          </>
        )}
        {diff === 0n && counted > 0n && <p className="muted small-note">{t("noEntry")}</p>}

        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {t(`errors.${e.form}`)}
          </p>
        )}
        {confirming ? (
          <div className="confirm-close" role="alertdialog" aria-labelledby="confirm-close-title">
            <strong id="confirm-close-title">{t("confirmTitle", { date: dateLabel })}</strong>
            <p>{t("confirmBody", { date: dateLabel, next: nextLabel })}</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={pending}>
                {t("back")}
              </button>
              <button className="btn danger" disabled={pending} autoFocus>
                {pending ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> {t("closing")}
                  </>
                ) : (
                  t("confirm")
                )}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary block">
            <span aria-hidden="true">🔒</span> {t("close", { date: dateLabel })}
          </button>
        )}
      </aside>
    </form>
  );
}
