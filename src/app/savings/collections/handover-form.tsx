"use client";

import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { parseTaka, toTakaDecimal } from "@/lib/money";
import { receiveHandoverAction, type HandoverState } from "./actions";

/** The cashier's count of a collector's cash, opened from their card. */
export function HandoverForm({ collectorId, collectorName, held }: { collectorId: string; collectorName: string; held: string }) {
  const t = useTranslations("savings.collections");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<HandoverState, FormData>(receiveHandoverAction.bind(null, collectorId), {});
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const holding = BigInt(held);
  const asInput = (p: bigint) => {
    const s = toTakaDecimal(p).replace(/\.00$/, "");
    return locale === "bn" ? toBanglaDigits(s) : s;
  };
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => asInput(holding));
  const [note, setNote] = useState("");
  const [edited, setEdited] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(false);
  }
  const taka = (p: bigint) => formatTaka(p, locale);
  const paisa = parseTaka(amount) ?? 0n;
  const over = paisa > holding;
  const e = state.errors ?? {};
  const msg = (code: string | undefined) =>
    code ? t(`errors.${code}` as "errors.server", { amount: taka(state.held ? BigInt(state.held) : holding) }) : undefined;
  const fieldId = `amount-${collectorId}`;

  if (!open) {
    return (
      <button type="button" className="btn primary block" onClick={() => setOpen(true)}>
        <span aria-hidden="true">🤝</span> {t("receive")}
      </button>
    );
  }

  return (
    <form
      className="handover-form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const data = new FormData(ev.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <strong className="handover-title">{t("formTitle", { name: collectorName })}</strong>
      <div className={`field big-amount${(!edited && e.amount) || over ? " has-error" : ""}`}>
        <label htmlFor={fieldId}>{t("amount")}</label>
        <span className="money-input">
          <span aria-hidden="true">৳</span>
          <input
            id={fieldId}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={amount}
            onChange={(ev) => {
              setAmount(ev.target.value);
              setEdited(true);
            }}
          />
        </span>
        {!edited && e.amount ? (
          <small className="field-error">{msg(e.amount)}</small>
        ) : over ? (
          <small className="field-error">{t("errors.over_held", { amount: taka(holding) })}</small>
        ) : paisa > 0n && paisa < holding ? (
          <small className="short-note">{t("short", { amount: taka(holding - paisa) })}</small>
        ) : null}
      </div>
      {paisa !== holding && (
        <div className="quick-picks">
          <button type="button" onClick={() => setAmount(asInput(holding))}>
            {t("all", { amount: taka(holding) })}
          </button>
        </div>
      )}
      <div className="field">
        <label htmlFor={`note-${collectorId}`}>{t("note")}</label>
        <input
          id={`note-${collectorId}`}
          name="note"
          maxLength={300}
          value={note}
          placeholder={t("notePlaceholder")}
          onChange={(ev) => setNote(ev.target.value)}
        />
        {!edited && e.note && <small className="field-error">{msg(e.note)}</small>}
      </div>
      <div className="entry-preview mini">
        <div className="entry-row">
          <span className="side dr">{t("debit")}</span>
          <span className="account">{t("cashInHand")}</span>
          <strong>{taka(paisa)}</strong>
        </div>
        <div className="entry-row">
          <span className="side cr">{t("credit")}</span>
          <span className="account">{t("cashWithCollector")}</span>
          <strong>{taka(paisa)}</strong>
        </div>
      </div>
      {e.form && (
        <p className="form-error" role="alert" key={state.attempt}>
          {msg(e.form)}
        </p>
      )}
      <div className="handover-actions">
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
        <button className="btn primary" disabled={pending || paisa <= 0n || over}>
          {pending ? t("posting") : t("confirm", { amount: taka(paisa) })}
        </button>
      </div>
    </form>
  );
}
