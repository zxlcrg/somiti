"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { decideWithdrawalAction, type DecideState } from "./actions";

/** Approve or reject (a different officer), or take back (whoever entered it). */
export function WithdrawalDecision({
  withdrawalId,
  returnTo,
  mode,
}: {
  withdrawalId: string;
  returnTo: string;
  mode: "checker" | "maker";
}) {
  const t = useTranslations("savings.withdrawals");
  const [state, action, pending] = useActionState<DecideState, FormData>(decideWithdrawalAction.bind(null, withdrawalId, returnTo), {});
  const [asking, setAsking] = useState(false);
  const noteId = `note-${withdrawalId}`;

  return (
    <div className="wd-decision">
      {!asking ? (
        <div className="decision-actions">
          {mode === "checker" ? (
            <>
              <form action={action}>
                <input type="hidden" name="kind" value="approve" />
                <button className="btn primary" disabled={pending}>
                  ✓ {pending ? t("working") : t("approve")}
                </button>
              </form>
              <button type="button" className="btn ghost" onClick={() => setAsking(true)} disabled={pending}>
                ✕ {t("reject")}
              </button>
            </>
          ) : (
            <button type="button" className="btn ghost" onClick={() => setAsking(true)}>
              ↩ {t("cancel")}
            </button>
          )}
        </div>
      ) : (
        <form action={action} className="reject-form">
          <input type="hidden" name="kind" value={mode === "checker" ? "reject" : "cancel"} />
          <label htmlFor={noteId}>{mode === "checker" ? t("rejectReason") : t("cancel")}</label>
          <textarea
            id={noteId}
            name="note"
            rows={2}
            maxLength={1000}
            required={mode === "checker"}
            autoFocus
            placeholder={mode === "checker" ? t("rejectPlaceholder") : undefined}
          />
          <div className="decision-actions">
            <button className="btn danger" disabled={pending}>
              {pending ? t("working") : mode === "checker" ? t("confirmReject") : t("confirmCancel")}
            </button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              {t("back")}
            </button>
          </div>
        </form>
      )}
      {state.error && (
        <p className="form-error" role="alert" key={state.attempt}>
          {t(`errors.${state.error}` as "errors.server")}
        </p>
      )}
    </div>
  );
}
