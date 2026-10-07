"use client";

import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { parseTaka, toTakaDecimal } from "@/lib/money";
import { METHOD_ICON } from "../../ui";
import { depositAction, type DepositState } from "./actions";

const METHODS = ["cash", "bank", "mobile_wallet"] as const;
type Method = (typeof METHODS)[number];

export function DepositForm({
  accountId,
  memberName,
  channel,
  installment,
  behind,
  balance,
  minDeposit,
}: {
  accountId: string;
  memberName: string;
  channel: "office" | "collector";
  /** Paisa strings; installment is null on flexible products. */
  installment: string | null;
  behind: string;
  balance: string;
  minDeposit: string;
}) {
  const t = useTranslations("savings");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<DepositState, FormData>(depositAction.bind(null, accountId), {});
  // One key per visit to this form: a double click or a retry after a lost connection posts once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const due = BigInt(behind);
  const each = installment ? BigInt(installment) : null;
  const asInput = (p: bigint) => {
    const s = toTakaDecimal(p).replace(/\.00$/, "");
    return locale === "bn" ? toBanglaDigits(s) : s;
  };
  const [amount, setAmount] = useState(() => (due > 0n ? asInput(due) : each ? asInput(each) : ""));
  const [method, setMethod] = useState<Method>("cash");
  const [ref, setRef] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const touch = (...f: string[]) => setEdited((prev) => new Set([...prev, ...f]));
  const taka = (p: bigint) => formatTaka(p, locale);
  const e = state.errors ?? {};
  const err = (f: "amount" | "method" | "paymentRef") =>
    e[f] && !edited.has(f) ? t(`depositErrors.${e[f]}` as "depositErrors.server", { amount: taka(BigInt(minDeposit)) }) : undefined;

  const paisa = parseTaka(amount) ?? 0n;
  const quick: { label: string; value: bigint }[] = [];
  if (due > 0n) quick.push({ label: t("depositForm.clearDue"), value: due });
  if (each) for (const n of [1, 2, 5, 10]) quick.push({ label: t("depositForm.installments", { count: n }), value: each * BigInt(n) });
  else for (const v of [100_00n, 500_00n, 1000_00n, 5000_00n]) quick.push({ label: taka(v), value: v });
  const methods = channel === "collector" ? (["cash"] as const) : METHODS;
  const debit = channel === "collector" ? t("accounts.collector") : t(`accounts.${method}`);

  return (
    <form
      id="deposit"
      className="deposit-form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const data = new FormData(ev.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="method" value={method} />
      <h2>{t("depositForm.title")}</h2>

      <div className={`field big-amount${err("amount") ? " has-error" : ""}`}>
        <label htmlFor="amount">{t("depositForm.amount")}</label>
        <span className="money-input">
          <span aria-hidden="true">৳</span>
          <input
            id="amount"
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(ev) => {
              setAmount(ev.target.value);
              touch("amount");
            }}
            aria-invalid={err("amount") ? true : undefined}
          />
        </span>
        {err("amount") && <small className="field-error">{err("amount")}</small>}
      </div>
      <div className="quick-picks" role="group" aria-label={t("depositForm.quick")}>
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            className={paisa === q.value ? "on" : undefined}
            onClick={() => {
              setAmount(asInput(q.value));
              touch("amount");
            }}
          >
            {q.label}
          </button>
        ))}
      </div>

      {channel === "collector" ? (
        <p className="collector-note">
          <span aria-hidden="true">🚶</span> {t("depositForm.collectorNote")}
        </p>
      ) : (
        <>
          <span className="label">{t("depositForm.paidBy")}</span>
          <div className="method-tiles" role="radiogroup" aria-label={t("depositForm.paidBy")}>
            {methods.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={method === m}
                className={method === m ? "on" : undefined}
                onClick={() => {
                  setMethod(m);
                  touch("method", "paymentRef");
                }}
              >
                <span aria-hidden="true">{METHOD_ICON[m]}</span>
                {t(`methods.${m}`)}
              </button>
            ))}
          </div>
          {err("method") && <small className="field-error">{err("method")}</small>}
          {method !== "cash" && (
            <div className={`field ref-field${err("paymentRef") ? " has-error" : ""}`}>
              <label htmlFor="paymentRef">{t("depositForm.ref")}</label>
              <input
                id="paymentRef"
                name="paymentRef"
                value={ref}
                autoComplete="off"
                spellCheck={false}
                placeholder={method === "mobile_wallet" ? "8N7A2KQ1XZ" : ""}
                onChange={(ev) => {
                  setRef(ev.target.value);
                  touch("paymentRef");
                }}
              />
              {err("paymentRef") ? (
                <small className="field-error">{err("paymentRef")}</small>
              ) : (
                <small>{method === "mobile_wallet" ? t("depositForm.refWallet") : t("depositForm.refBank")}</small>
              )}
            </div>
          )}
        </>
      )}

      <div className="entry-preview mini">
        <span className="label">{t("depositForm.preview")}</span>
        <div className="entry-row">
          <span className="side dr">{t("depositForm.debit")}</span>
          <span className="account">{debit}</span>
          <strong>{taka(paisa)}</strong>
        </div>
        <div className="entry-row">
          <span className="side cr">{t("depositForm.credit")}</span>
          <span className="account">
            {t("accounts.member_savings")} · {memberName}
          </span>
          <strong>{taka(paisa)}</strong>
        </div>
        <p className="muted after-note" key={paisa.toString()}>
          {t("depositForm.after", { amount: taka(BigInt(balance) + paisa) })}
        </p>
      </div>

      {e.form && (
        <p className="form-error" role="alert" key={state.attempt}>
          {t(`depositErrors.${e.form}` as "depositErrors.server", { amount: taka(BigInt(minDeposit)) })}
        </p>
      )}
      <button className="btn primary block" disabled={pending || paisa <= 0n}>
        {pending ? (
          <>
            <span className="spinner" aria-hidden="true" /> {t("depositForm.posting")}
          </>
        ) : (
          t("depositForm.confirm", { amount: taka(paisa) })
        )}
      </button>
    </form>
  );
}
