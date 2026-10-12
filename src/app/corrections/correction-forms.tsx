"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { correctionAction, type CorrectionState } from "./actions";

type Step = "request" | "approve" | "reject" | "cancel";

function useCorrection(step: Step) {
  return useActionState<CorrectionState, FormData>(correctionAction.bind(null, step), {});
}

function Err({ state }: { state: CorrectionState }) {
  const t = useTranslations("corrections");
  return state.error ? (
    <p className="form-error" role="alert" key={state.attempt}>
      {t(`errors.${state.error}`)}
    </p>
  ) : null;
}

/** The officer who spotted the mistake says what went wrong. */
export function RequestForm({ entryId }: { entryId: string }) {
  const t = useTranslations("corrections");
  const [state, action, pending] = useCorrection("request");
  const [submitKey] = useState(() => crypto.randomUUID());
  return (
    <form action={action} className="step-form" noValidate>
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="submitKey" value={submitKey} />
      <div className="field">
        <label htmlFor="reason">{t("reason")}</label>
        <textarea id="reason" name="reason" rows={3} maxLength={300} required placeholder={t("reasonPlaceholder")} />
        <small>{t("reasonHint")}</small>
      </div>
      <Err state={state} />
      <button className="btn primary block" disabled={pending}>
        {pending ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">📨</span>} {t("ask")}
      </button>
    </form>
  );
}

/** Approve (with a confirm step) or turn down someone else's request; withdraw your own. */
export function DecideForm({ correctionId, mine, canDecide, amount }: { correctionId: string; mine: boolean; canDecide: boolean; amount: string }) {
  const t = useTranslations("corrections");
  const [approveState, approve, approving] = useCorrection("approve");
  const [rejectState, reject, rejecting] = useCorrection("reject");
  const [cancelState, cancel, cancelling] = useCorrection("cancel");
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(approveState);
  if (seen !== approveState) {
    setSeen(approveState);
    setConfirming(false);
  }

  if (mine) {
    return (
      <form action={cancel} className="step-form" noValidate>
        <input type="hidden" name="correctionId" value={correctionId} />
        <p className="notice soft">
          <span aria-hidden="true">⏳</span> {t("waitingOther")}
        </p>
        <Err state={cancelState} />
        <button className="btn ghost block" disabled={cancelling}>
          {cancelling && <span className="spinner" aria-hidden="true" />} {t("withdraw")}
        </button>
      </form>
    );
  }
  if (!canDecide) return <p className="notice soft">{t("waitingManager")}</p>;

  return (
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
          <input type="hidden" name="correctionId" value={correctionId} />
          <div className="field">
            <label htmlFor={`note-${correctionId}`}>{t("note")}</label>
            <input id={`note-${correctionId}`} name="note" maxLength={300} />
          </div>
          <Err state={approveState} />
          {confirming ? (
            <div className="confirm-close" role="alertdialog" aria-labelledby={`confirm-${correctionId}`}>
              <strong id={`confirm-${correctionId}`}>{t("confirmTitle", { amount })}</strong>
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
              <span aria-hidden="true">↩️</span> {t("approve")}
            </button>
          )}
        </form>
      ) : (
        <form action={reject} className="step-form" noValidate>
          <input type="hidden" name="correctionId" value={correctionId} />
          <div className="field">
            <label htmlFor={`reject-${correctionId}`}>{t("rejectReason")}</label>
            <textarea id={`reject-${correctionId}`} name="note" rows={3} maxLength={300} required />
          </div>
          <Err state={rejectState} />
          <button className="btn primary block" disabled={rejecting}>
            {rejecting && <span className="spinner" aria-hidden="true" />} {t("reject")}
          </button>
        </form>
      )}
    </>
  );
}
