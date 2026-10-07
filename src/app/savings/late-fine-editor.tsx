"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { toTakaDecimal } from "@/lib/money";
import { setLateFineAction, type LateFineState } from "./actions";

/** A product card's "Change fine" link, opening a small form in place. */
export function LateFineEditor({ productId, code, lateFine }: { productId: string; code: string; lateFine: string | null }) {
  const t = useTranslations("savings.fines");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<LateFineState, FormData>(setLateFineAction.bind(null, productId), {});
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    if (state.saved) setOpen(false);
  }
  const start = lateFine ? toTakaDecimal(BigInt(lateFine)).replace(/\.00$/, "") : "";
  // Controlled, so a refused value stays in the box (a form action resets uncontrolled inputs).
  const [value, setValue] = useState(locale === "bn" ? toBanglaDigits(start) : start);

  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        {t("change")}
      </button>
    );
  }
  return (
    <form action={action} className="fine-editor" noValidate>
      <label htmlFor={`fine-${productId}`}>{t("editLabel", { code })}</label>
      <span className="money-input">
        <span aria-hidden="true">৳</span>
        <input
          id={`fine-${productId}`}
          name="lateFine"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          autoFocus
          aria-invalid={state.error ? true : undefined}
        />
      </span>
      {state.error ? (
        <small className="field-error" role="alert" key={state.attempt}>
          {t(`errors.${state.error}`)}
        </small>
      ) : (
        <small className="muted">{t("editHint")}</small>
      )}
      <div className="fine-editor-actions">
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
        <button className="btn primary small" disabled={pending}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}
