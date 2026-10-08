"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { loanStepAction, type LoanStepState } from "../actions";
import { METHOD_ICON } from "../ui-client";

type Step = "approve" | "reject" | "cancel" | "disburse";

function StepError({ state }: { state: LoanStepState }) {
  const t = useTranslations("loans");
  return state.error ? (
    <p className="form-error" role="alert" key={state.attempt}>
      {t(`stepErrors.${state.error}`)}
    </p>
  ) : null;
}

function useStep(loanId: string, step: Step) {
  return useActionState<LoanStepState, FormData>(loanStepAction.bind(null, loanId, step), {});
}

/** Approve (with the meeting date) or turn down, for an officer who didn't enter the application. */
export function DecidePanel({ loanId, today }: { loanId: string; today: string }) {
  const t = useTranslations("loans");
  const [approveState, approve, approving] = useStep(loanId, "approve");
  const [rejectState, reject, rejecting] = useStep(loanId, "reject");
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  return (
    <section className="loan-card step-card decide">
      <h2>
        <span aria-hidden="true">🧑‍⚖️</span> {t("steps.decideTitle")}
      </h2>
      <div className="seg" role="tablist">
        {(["approve", "reject"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? `on ${m}` : undefined} onClick={() => setMode(m)}>
            {t(`steps.${m}Tab`)}
          </button>
        ))}
      </div>
      {mode === "approve" ? (
        <form action={approve} className="step-form" noValidate>
          <div className="field">
            <label htmlFor="meetingOn">{t("steps.meetingOn")}</label>
            <input id="meetingOn" name="meetingOn" type="date" max={today} />
            <small>{t("steps.meetingHint")}</small>
          </div>
          <div className="field">
            <label htmlFor="approveNote">{t("steps.note")}</label>
            <input id="approveNote" name="note" maxLength={300} />
          </div>
          <StepError state={approveState} />
          <button className="btn primary block" disabled={approving}>
            {approving ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">✅</span>} {t("steps.approve")}
          </button>
        </form>
      ) : (
        <form action={reject} className="step-form" noValidate>
          <div className="field">
            <label htmlFor="rejectNote">{t("steps.rejectReason")}</label>
            <textarea id="rejectNote" name="note" rows={3} maxLength={300} required />
            <small>{t("steps.rejectHint")}</small>
          </div>
          <StepError state={rejectState} />
          <button className="btn danger block" disabled={rejecting}>
            {rejecting ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">⛔</span>} {t("steps.reject")}
          </button>
        </form>
      )}
    </section>
  );
}

/** The cashier's payout: how the money leaves, and the entry it makes. */
export function DisbursePanel({ loanId, principal, fee, memberName }: { loanId: string; principal: string; fee: string; memberName: string }) {
  const t = useTranslations("loans");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useStep(loanId, "disburse");
  const [method, setMethod] = useState<"cash" | "bank" | "mobile_wallet">("cash");
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setConfirming(false);
  }
  const taka = (p: bigint) => formatTaka(p, locale);
  const p = BigInt(principal);
  const f = BigInt(fee);
  const from = t(`steps.from.${method}`);
  return (
    <section className="loan-card step-card pay">
      <h2>
        <span aria-hidden="true">💸</span> {t("steps.payTitle")}
      </h2>
      <form
        action={action}
        className="step-form"
        noValidate
        onSubmit={(ev) => {
          if (!confirming) {
            ev.preventDefault();
            setConfirming(true);
          }
        }}
      >
        <input type="hidden" name="method" value={method} />
        <span className="label">{t("steps.payBy")}</span>
        <div className="method-tiles" role="radiogroup" aria-label={t("steps.payBy")}>
          {(["cash", "bank", "mobile_wallet"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? "on" : undefined} onClick={() => setMethod(m)}>
              <span aria-hidden="true">{METHOD_ICON[m]}</span>
              {t(`steps.method.${m}`)}
            </button>
          ))}
        </div>
        {method !== "cash" && (
          <div className="field ref-field">
            <label htmlFor="paymentRef">{t(`steps.ref.${method}`)}</label>
            <input id="paymentRef" name="paymentRef" maxLength={64} autoComplete="off" />
          </div>
        )}
        <div className="entry-preview">
          <span className="label">{t("steps.entry")}</span>
          <div className="entry-row">
            <span className="side dr">{t("steps.debit")}</span>
            <span className="account">{t("steps.receivable", { name: memberName })}</span>
            <strong>{taka(p)}</strong>
          </div>
          <div className="entry-row">
            <span className="side cr">{t("steps.credit")}</span>
            <span className="account">{from}</span>
            <strong>{taka(p - f)}</strong>
          </div>
          {f > 0n && (
            <div className="entry-row">
              <span className="side cr">{t("steps.credit")}</span>
              <span className="account">{t("steps.feeIncome")}</span>
              <strong>{taka(f)}</strong>
            </div>
          )}
        </div>
        <StepError state={state} />
        {confirming ? (
          <div className="confirm-close" role="alertdialog" aria-labelledby="confirm-pay">
            <strong id="confirm-pay">{t("steps.confirmPay", { amount: taka(p - f), name: memberName })}</strong>
            <p>{t("steps.confirmPayBody")}</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={pending}>
                {t("steps.back")}
              </button>
              <button className="btn primary" disabled={pending} autoFocus>
                {pending ? <span className="spinner" aria-hidden="true" /> : null} {t("steps.payNow")}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary block">
            <span aria-hidden="true">💸</span> {t("steps.pay", { amount: taka(p - f) })}
          </button>
        )}
      </form>
    </section>
  );
}

/** Withdraws an application, or an approved loan not yet paid; a reason is needed once approved. */
export function CancelPanel({ loanId, needsReason }: { loanId: string; needsReason: boolean }) {
  const t = useTranslations("loans");
  const [state, action, pending] = useStep(loanId, "cancel");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn ghost small cancel-link" onClick={() => setOpen(true)}>
        ↩️ {t("steps.cancelOpen")}
      </button>
    );
  }
  return (
    <form action={action} className="loan-card step-card cancel step-form" noValidate>
      <div className="field">
        <label htmlFor="cancelNote">{needsReason ? t("steps.cancelReason") : t("steps.cancelReasonOptional")}</label>
        <input id="cancelNote" name="note" maxLength={300} required={needsReason} />
      </div>
      <StepError state={state} />
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          {t("steps.back")}
        </button>
        <button className="btn danger" disabled={pending}>
          {t("steps.cancel")}
        </button>
      </div>
    </form>
  );
}
