"use client";

import { useActionState, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { addDays, addMonths } from "@/lib/dates";
import { toLatinDigits } from "@/lib/digits";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { outstanding, type InstallmentState } from "@/modules/loans/allocate";
import { rescheduleRows, type LoanFrequency } from "@/modules/loans/schedule";
import { rescheduleLoanAction, type RescheduleState } from "../actions";
import type { SerialRow } from "./repay-panel";

/** A managing officer's form for a new schedule, with the installments it will write. */
export function ReschedulePanel({
  loanId,
  rows: raw,
  today,
  frequency,
  charge,
}: {
  loanId: string;
  rows: SerialRow[];
  today: string;
  frequency: LoanFrequency;
  charge: string;
}) {
  const t = useTranslations("loans");
  const l = useLocale();
  const locale = isLocale(l) ? l : defaultLocale;
  const [state, action, pending] = useActionState<RescheduleState, FormData>(rescheduleLoanAction.bind(null, loanId), {});
  const rows = useMemo<InstallmentState[]>(
    () =>
      raw.map((r) => ({
        seq: r.seq,
        dueOn: r.dueOn,
        principal: BigInt(r.principal),
        interest: BigInt(r.interest),
        paidPrincipal: BigInt(r.paidPrincipal),
        paidInterest: BigInt(r.paidInterest),
        rebated: BigInt(r.rebated),
        movedPrincipal: BigInt(r.movedPrincipal),
        movedInterest: BigInt(r.movedInterest),
      })),
    [raw],
  );
  const owed = outstanding(rows);
  const left = rows.filter((r) => r.principal + r.interest - r.paidPrincipal - r.paidInterest - (r.rebated ?? 0n) - (r.movedPrincipal ?? 0n) - (r.movedInterest ?? 0n) > 0n).length;
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(String(Math.max(left, 1)));
  const [first, setFirst] = useState(frequency === "weekly" ? addDays(today, 7) : addMonths(today, 1));
  const [extra, setExtra] = useState("");
  const [reason, setReason] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const touch = (f: string) => setEdited((prev) => new Set(prev).add(f));
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (x: number) => formatInteger(x, locale);

  const count = Number(toLatinDigits(n.trim()));
  const extraPaisa = extra.trim() ? parseTaka(extra) : 0n;
  const valid = Number.isInteger(count) && count >= 1 && count <= 520 && extraPaisa !== null && extraPaisa >= 0n && /^\d{4}-\d{2}-\d{2}$/.test(first) && first > today;
  const fresh = valid ? rescheduleRows({ principal: owed.principal, interest: owed.interest + extraPaisa, installments: count, frequency, firstDueOn: first }) : null;
  const e = state.errors ?? {};
  const err = (f: "installments" | "firstDueOn" | "extraCharge" | "reason") => (e[f] && !edited.has(f) ? t(`rescheduleErrors.${e[f]}`) : null);

  if (!open) {
    return (
      <section className="loan-card resched-card closed">
        <h2>
          <span aria-hidden="true">🔁</span> {t("reschedule.title")}
        </h2>
        <p className="muted">{t("reschedule.lead", { n: num(left), count: left, amount: taka(owed.total) })}</p>
        <button type="button" className="btn ghost block" onClick={() => setOpen(true)}>
          {t("reschedule.open")}
        </button>
      </section>
    );
  }

  return (
    <section className="loan-card step-card resched-card">
      <h2>
        <span aria-hidden="true">🔁</span> {t("reschedule.title")}
      </h2>
      <dl className="repay-owed">
        <div>
          <dt>{t("schedule.principal")}</dt>
          <dd>{taka(owed.principal)}</dd>
        </div>
        <div>
          <dt>{charge}</dt>
          <dd>{taka(owed.interest)}</dd>
        </div>
      </dl>
      <form action={action} className="step-form" noValidate>
        <div className="resched-grid">
          <div className={`field${err("installments") ? " has-error" : ""}`}>
            <label htmlFor="reschedN">{t("reschedule.installments")}</label>
            <input id="reschedN" name="installments" inputMode="numeric" autoComplete="off" value={n} onChange={(ev) => {
              setN(ev.target.value);
              touch("installments");
            }} />
            {err("installments") && <small className="field-error">{err("installments")}</small>}
          </div>
          <div className={`field${err("firstDueOn") ? " has-error" : ""}`}>
            <label htmlFor="reschedFirst">{t("reschedule.firstDueOn")}</label>
            <input id="reschedFirst" name="firstDueOn" type="date" min={addDays(today, 1)} max={addMonths(today, 12)} value={first} onChange={(ev) => {
              setFirst(ev.target.value);
              touch("firstDueOn");
            }} />
            {err("firstDueOn") && <small className="field-error">{err("firstDueOn")}</small>}
          </div>
        </div>
        <div className={`field${err("extraCharge") ? " has-error" : ""}`}>
          <label htmlFor="reschedExtra">{t("reschedule.extraCharge", { charge: charge.toLowerCase() })}</label>
          <span className="money-input">
            <span aria-hidden="true">৳</span>
            <input id="reschedExtra" name="extraCharge" inputMode="decimal" autoComplete="off" placeholder="0" value={extra} onChange={(ev) => {
              setExtra(ev.target.value);
              touch("extraCharge");
            }} />
          </span>
          {err("extraCharge") ? <small className="field-error">{err("extraCharge")}</small> : <small>{t("reschedule.extraHint")}</small>}
        </div>
        <div className={`field${err("reason") ? " has-error" : ""}`}>
          <label htmlFor="reschedReason">{t("reschedule.reason")}</label>
          <textarea id="reschedReason" name="reason" rows={2} maxLength={300} value={reason} onChange={(ev) => {
              setReason(ev.target.value);
              touch("reason");
            }} />
          {err("reason") ? <small className="field-error">{err("reason")}</small> : <small>{t("reschedule.reasonHint")}</small>}
        </div>

        {fresh ? (
          <div className="resched-preview" aria-live="polite">
            <span className="label">{t("reschedule.preview")}</span>
            <div className="example-figure">
              <span>{t("reschedule.each", { n: num(count), count })}</span>
              <strong>{taka(fresh[0]!.principal + fresh[0]!.interest)}</strong>
            </div>
            <dl className="example-rows">
              <div>
                <dt>{t("reschedule.firstLast")}</dt>
                <dd>
                  {formatDate(fresh[0]!.dueOn, locale)} – {formatDate(fresh.at(-1)!.dueOn, locale)}
                </dd>
              </div>
              {fresh.length > 1 && fresh.at(-1)!.principal + fresh.at(-1)!.interest !== fresh[0]!.principal + fresh[0]!.interest && (
                <div>
                  <dt>{t("reschedule.last")}</dt>
                  <dd>{taka(fresh.at(-1)!.principal + fresh.at(-1)!.interest)}</dd>
                </div>
              )}
              <div className="total">
                <dt>{t("reschedule.total")}</dt>
                <dd>{taka(owed.total + extraPaisa!)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          valid && <p className="field-error">{t("rescheduleErrors.too_many_installments")}</p>
        )}

        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {t(`rescheduleErrors.${e.form}`)}
          </p>
        )}
        <p className="muted small-note">{t("reschedule.note")}</p>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => setOpen(false)} disabled={pending}>
            {t("steps.back")}
          </button>
          <button className="btn primary" disabled={pending || !fresh}>
            {pending ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">🔁</span>} {t("reschedule.submit")}
          </button>
        </div>
      </form>
    </section>
  );
}
