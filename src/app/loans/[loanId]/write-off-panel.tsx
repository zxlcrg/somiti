"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { writeOffAction, type WriteOffState } from "../actions";

type Step = "request" | "approve" | "reject" | "cancel";

function useWriteOff(loanId: string, step: Step) {
  return useActionState<WriteOffState, FormData>(writeOffAction.bind(null, loanId, step), {});
}

function Err({ state }: { state: WriteOffState }) {
  const t = useTranslations("loans.writeOff");
  return state.error ? (
    <p className="form-error" role="alert" key={state.attempt}>
      {t(`errors.${state.error}`)}
    </p>
  ) : null;
}

export interface PendingWriteOff {
  id: string;
  reason: string;
  askedBy: string;
  askedOn: string;
  mine: boolean;
}

/**
 * Writing a loan off: one managing officer asks with a reason, a different
 * one approves (posting the principal still owed to bad debts) or turns it down.
 */
export function WriteOffPanel({ loanId, principal, charge, pending }: { loanId: string; principal: string; charge: string; pending: PendingWriteOff | null }) {
  const t = useTranslations("loans.writeOff");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const taka = (p: string) => formatTaka(BigInt(p), locale);
  const [requestState, request, requesting] = useWriteOff(loanId, "request");
  const [approveState, approve, approving] = useWriteOff(loanId, "approve");
  const [rejectState, reject, rejecting] = useWriteOff(loanId, "reject");
  const [cancelState, cancel, cancelling] = useWriteOff(loanId, "cancel");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [confirming, setConfirming] = useState(false);
  const [submitKey] = useState(() => crypto.randomUUID());
  const [seen, setSeen] = useState(approveState);
  if (seen !== approveState) {
    setSeen(approveState);
    setConfirming(false);
  }

  const figures = (
    <dl className="wo-figures">
      <div>
        <dt>{t("principal")}</dt>
        <dd>{taka(principal)}</dd>
      </div>
      <div>
        <dt>{t("charge")}</dt>
        <dd>{taka(charge)}</dd>
      </div>
    </dl>
  );

  if (!pending) {
    return (
      <section className={`loan-card write-off-card${open ? " open" : ""}`}>
        <button type="button" className="wo-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">🗂️</span>
          <span>
            <strong>{t("title")}</strong>
            <small className="muted">{t("teaser")}</small>
          </span>
          <span className="wo-chevron" aria-hidden="true">
            {open ? "▴" : "▾"}
          </span>
        </button>
        {open && (
          <form action={request} className="step-form" noValidate>
            <input type="hidden" name="submitKey" value={submitKey} />
            {figures}
            <p className="muted small-note">{t("explain")}</p>
            <div className="field">
              <label htmlFor="woReason">{t("reason")}</label>
              <textarea id="woReason" name="reason" rows={3} maxLength={300} required placeholder={t("reasonPlaceholder")} />
              <small>{t("reasonHint")}</small>
            </div>
            <Err state={requestState} />
            <button className="btn danger block" disabled={requesting}>
              {requesting ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">📨</span>} {t("ask")}
            </button>
          </form>
        )}
      </section>
    );
  }

  return (
    <section className="loan-card write-off-card open pending">
      <h2>
        <span aria-hidden="true">🗂️</span> {t("pendingTitle")}
      </h2>
      <blockquote className="wo-reason">
        <p>{pending.reason}</p>
        <footer className="muted">{t("askedBy", { name: pending.askedBy, date: pending.askedOn })}</footer>
      </blockquote>
      {figures}
      {pending.mine ? (
        <form action={cancel} className="step-form" noValidate>
          <input type="hidden" name="writeOffId" value={pending.id} />
          <p className="notice soft">
            <span aria-hidden="true">⏳</span> {t("waitingOther")}
          </p>
          <Err state={cancelState} />
          <button className="btn ghost block" disabled={cancelling}>
            {cancelling && <span className="spinner" aria-hidden="true" />} {t("withdraw")}
          </button>
        </form>
      ) : (
        <>
          <div className="seg" role="tablist">
            {(["approve", "reject"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? `on ${m}` : undefined} onClick={() => setMode(m)}>
                {t(`${m}Tab`)}
              </button>
            ))}
          </div>
          {mode === "approve" ? (
            <form
              action={approve}
              className="step-form"
              noValidate
              onSubmit={(ev) => {
                if (!confirming) {
                  ev.preventDefault();
                  setConfirming(true);
                }
              }}
            >
              <input type="hidden" name="writeOffId" value={pending.id} />
              <div className="field">
                <label htmlFor="woNote">{t("note")}</label>
                <input id="woNote" name="note" maxLength={300} />
              </div>
              <Err state={approveState} />
              {confirming ? (
                <div className="confirm-close" role="alertdialog" aria-labelledby="wo-confirm">
                  <strong id="wo-confirm">{t("confirmTitle", { amount: taka(principal) })}</strong>
                  <p>{t("confirmBody")}</p>
                  <div className="confirm-actions">
                    <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={approving}>
                      {t("back")}
                    </button>
                    <button className="btn danger" disabled={approving} autoFocus>
                      {approving && <span className="spinner" aria-hidden="true" />} {t("confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn danger block">
                  <span aria-hidden="true">🗂️</span> {t("approve")}
                </button>
              )}
            </form>
          ) : (
            <form action={reject} className="step-form" noValidate>
              <input type="hidden" name="writeOffId" value={pending.id} />
              <div className="field">
                <label htmlFor="woRejectNote">{t("rejectReason")}</label>
                <textarea id="woRejectNote" name="note" rows={3} maxLength={300} required />
              </div>
              <Err state={rejectState} />
              <button className="btn primary block" disabled={rejecting}>
                {rejecting && <span className="spinner" aria-hidden="true" />} {t("reject")}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
