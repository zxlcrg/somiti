"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { requestExitAction, type ExitRequestState } from "./actions";

const METHODS = [
  { value: "cash", icon: "💵" },
  { value: "bank", icon: "🏦" },
  { value: "mobile_wallet", icon: "📱" },
] as const;

export function ExitForm({ memberId }: { memberId: string }) {
  const t = useTranslations("members.exit");
  const tShares = useTranslations("members.shares");
  const [state, action, pending] = useActionState<ExitRequestState, FormData>(requestExitAction.bind(null, memberId), {});
  // One key per visit: a double click sends one request.
  const [submitKey] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("cash");
  const [reason, setReason] = useState("");
  const [ref, setRef] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const e = state.errors ?? {};
  const err = (f: "reason" | "method" | "paymentRef") =>
    e[f] && !edited.has(f) ? t(`errors.${e[f]}` as "errors.server") : undefined;
  const touch = (f: string) => setEdited((prev) => new Set(prev).add(f));

  return (
    <form
      className="buy-shares exit-form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const data = new FormData(ev.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="submitKey" value={submitKey} />
      <input type="hidden" name="method" value={method} />

      <section className="buy-card">
        <div className={`field${err("reason") ? " has-error" : ""}`}>
          <label htmlFor="reason">{t("form.reason")}</label>
          <textarea
            id="reason"
            name="reason"
            rows={3}
            value={reason}
            maxLength={500}
            placeholder={t("form.reasonPlaceholder")}
            onChange={(ev) => {
              setReason(ev.target.value);
              touch("reason");
            }}
          />
          {err("reason") && <small className="field-error">{err("reason")}</small>}
        </div>
      </section>

      <section className="buy-card">
        <span className="label">{t("form.paidBy")}</span>
        <div className="method-tiles" role="radiogroup" aria-label={t("form.paidBy")}>
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={method === m.value}
              className={method === m.value ? "on" : undefined}
              onClick={() => {
                setMethod(m.value);
                touch("method");
                touch("paymentRef");
              }}
            >
              <span aria-hidden="true">{m.icon}</span>
              {tShares(`methods.${m.value}`)}
            </button>
          ))}
        </div>
        {err("method") && <small className="field-error">{err("method")}</small>}
        {method !== "cash" && (
          <div className={`field ref-field${err("paymentRef") ? " has-error" : ""}`}>
            <label htmlFor="paymentRef">{t("form.ref")}</label>
            <input
              id="paymentRef"
              name="paymentRef"
              value={ref}
              onChange={(ev) => {
                setRef(ev.target.value);
                touch("paymentRef");
              }}
              autoComplete="off"
              spellCheck={false}
            />
            {err("paymentRef") ? (
              <small className="field-error">{err("paymentRef")}</small>
            ) : (
              <small>{method === "mobile_wallet" ? t("form.refWallet") : t("form.refBank")}</small>
            )}
          </div>
        )}
      </section>

      {e.form && (
        <p className="form-error" role="alert" key={state.attempt}>
          {t(`errors.${e.form}` as "errors.server")}
        </p>
      )}

      <div className="form-actions">
        <Link href={`/members/${memberId}`} className="btn ghost">
          {t("form.cancel")}
        </Link>
        <button className="btn danger" disabled={pending}>
          {pending ? (
            <>
              <span className="spinner" aria-hidden="true" /> {t("form.sending")}
            </>
          ) : (
            t("form.submit")
          )}
        </button>
      </div>
    </form>
  );
}
