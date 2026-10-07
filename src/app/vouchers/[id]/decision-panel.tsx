"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { decideVoucherAction, type DecisionState } from "./actions";

/** Approve or reject (a different officer), or withdraw (the maker). */
export function DecisionPanel({
  voucherId,
  mode,
  amount,
}: {
  voucherId: string;
  mode: "checker" | "maker";
  amount: string;
}) {
  const t = useTranslations("books.detail");
  const tErr = useTranslations("ledger.errors");
  const [state, action, pending] = useActionState<DecisionState, FormData>(decideVoucherAction.bind(null, voucherId), {});
  const [rejecting, setRejecting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const error = state.error
    ? state.error === "forbidden" || state.error === "server" || state.error === "note_required"
      ? t(`errors.${state.error}`)
      : tErr(state.error)
    : undefined;

  return (
    <section className={`decision ${mode}`}>
      {mode === "checker" ? (
        <>
          <h2>{t("checkerTitle")}</h2>
          <p className="muted">{t("checkerBody", { amount })}</p>
          {!rejecting ? (
            <div className="decision-actions">
              <form action={action}>
                <input type="hidden" name="kind" value="approve" />
                <button className="btn primary big" disabled={pending}>
                  ✓ {pending ? t("working") : t("approve")}
                </button>
              </form>
              <button type="button" className="btn ghost" onClick={() => setRejecting(true)} disabled={pending}>
                ✕ {t("reject")}
              </button>
            </div>
          ) : (
            <form action={action} className="reject-form">
              <input type="hidden" name="kind" value="reject" />
              <label htmlFor="note">{t("rejectReason")}</label>
              <textarea id="note" name="note" rows={2} maxLength={1000} required autoFocus placeholder={t("rejectPlaceholder")} />
              <div className="decision-actions">
                <button className="btn danger" disabled={pending}>
                  {pending ? t("working") : t("confirmReject")}
                </button>
                <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                  {t("back")}
                </button>
              </div>
            </form>
          )}
        </>
      ) : (
        <>
          <h2>{t("makerTitle")}</h2>
          <p className="muted">{t("makerBody")}</p>
          {!confirmCancel ? (
            <button type="button" className="btn ghost" onClick={() => setConfirmCancel(true)}>
              {t("withdraw")}
            </button>
          ) : (
            <form action={action} className="reject-form">
              <input type="hidden" name="kind" value="cancel" />
              <label htmlFor="note">{t("withdrawReason")}</label>
              <textarea id="note" name="note" rows={2} maxLength={1000} autoFocus />
              <div className="decision-actions">
                <button className="btn danger" disabled={pending}>
                  {pending ? t("working") : t("confirmWithdraw")}
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirmCancel(false)}>
                  {t("back")}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert" key={state.attempt}>
          {error}
        </p>
      )}
    </section>
  );
}
