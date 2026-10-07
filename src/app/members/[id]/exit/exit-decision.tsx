"use client";

import { startTransition, useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import {
  approveExitAction,
  cancelExitAction,
  rejectExitAction,
  type ExitDecisionState,
} from "./actions";

/** Approve / reject for a second officer; withdraw for the one who asked. */
export function ExitDecision({
  memberId,
  exitId,
  isRequester,
  amountLabel,
}: {
  memberId: string;
  exitId: string;
  isRequester: boolean;
  amountLabel: string;
}) {
  const t = useTranslations("members.exit");
  const [approveState, approve, approving] = useActionState<ExitDecisionState>(
    approveExitAction.bind(null, memberId, exitId),
    {},
  );
  const [rejectState, reject, rejecting] = useActionState<ExitDecisionState, FormData>(
    rejectExitAction.bind(null, memberId, exitId),
    {},
  );
  const [cancelState, cancel, cancelling] = useActionState<ExitDecisionState>(
    cancelExitAction.bind(null, memberId, exitId),
    {},
  );
  const [rejectOpen, setRejectOpen] = useState(false);
  const busy = approving || rejecting || cancelling;
  const error = approveState.error ?? rejectState.error ?? cancelState.error;

  if (isRequester) {
    return (
      <div className="exit-decision">
        <p className="muted small">{t("selfNote")}</p>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => startTransition(() => cancel())}>
          {cancelling ? <span className="spinner dark" aria-hidden="true" /> : null} {t("cancel")}
        </button>
        {error && (
          <p className="form-error" role="alert" key={cancelState.attempt}>
            {t(`errors.${error}` as "errors.server")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="exit-decision">
      {!rejectOpen ? (
        <div className="exit-buttons">
          <button type="button" className="btn primary" disabled={busy} onClick={() => startTransition(() => approve())}>
            {approving ? <span className="spinner" aria-hidden="true" /> : "✓"} {t("approve", { amount: amountLabel })}
          </button>
          <button type="button" className="btn ghost danger-outline" disabled={busy} onClick={() => setRejectOpen(true)}>
            {t("reject")}
          </button>
        </div>
      ) : (
        <form
          className="reject-form"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            startTransition(() => reject(data));
          }}
        >
          <label htmlFor="exit-reject-note">{t("rejectNote")}</label>
          <textarea id="exit-reject-note" name="note" rows={2} placeholder={t("rejectPlaceholder")} autoFocus />
          <div className="exit-buttons">
            <button type="submit" className="btn danger" disabled={busy}>
              {rejecting ? <span className="spinner" aria-hidden="true" /> : null} {t("confirmReject")}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setRejectOpen(false)}>
              {t("keep")}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert" key={`${approveState.attempt}-${rejectState.attempt}`}>
          {t(`errors.${error}` as "errors.server")}
        </p>
      )}
    </div>
  );
}
