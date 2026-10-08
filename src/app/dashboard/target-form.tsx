"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { setTargetAction, type TargetState } from "./actions";

/** Opens under the target card for the people who set it. */
export function TargetForm({ current, hasTarget }: { current: string; hasTarget: boolean }) {
  const t = useTranslations("dashboard.target");
  const [state, action, pending] = useActionState<TargetState, FormData>(setTargetAction, {});
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.saved) setOpen(false);
  }
  if (!open)
    return (
      <button type="button" className="btn ghost small target-edit" onClick={() => setOpen(true)}>
        <span aria-hidden="true">🎯</span> {hasTarget ? t("change") : t("set")}
      </button>
    );
  return (
    <form action={action} className="target-form" noValidate>
      <label htmlFor="target">{t("label")}</label>
      <div className="target-row">
        <span className="money-input">
          <span aria-hidden="true">৳</span>
          <input id="target" name="target" inputMode="decimal" autoComplete="off" defaultValue={current} placeholder="5,00,000" autoFocus aria-invalid={state.error ? true : undefined} />
        </span>
        <button className="btn primary small" disabled={pending}>
          {pending && <span className="spinner" aria-hidden="true" />} {t("save")}
        </button>
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </div>
      {state.error ? (
        <small className="field-error" role="alert" key={state.attempt}>
          {t(`errors.${state.error}`)}
        </small>
      ) : (
        <small className="muted">{t("hint")}</small>
      )}
    </form>
  );
}
