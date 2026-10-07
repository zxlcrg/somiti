"use client";

import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { parseTaka, toTakaDecimal } from "@/lib/money";
import { METHOD_ICON } from "../../ui";
import { requestWithdrawalAction, type WithdrawState } from "../../withdrawals/actions";

const METHODS = ["cash", "bank", "mobile_wallet"] as const;
type Method = (typeof METHODS)[number];

export function WithdrawForm({
  accountId,
  memberName,
  balance,
  held,
}: {
  accountId: string;
  memberName: string;
  /** Paisa strings. `held` is what pending requests already promise. */
  balance: string;
  held: string;
}) {
  const t = useTranslations("savings");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<WithdrawState, FormData>(requestWithdrawalAction.bind(null, accountId), {});
  const [submitKey] = useState(() => crypto.randomUUID());
  const free = BigInt(balance) - BigInt(held);
  const avail = free > 0n ? free : 0n;
  const asInput = (p: bigint) => {
    const s = toTakaDecimal(p).replace(/\.00$/, "");
    return locale === "bn" ? toBanglaDigits(s) : s;
  };
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [ref, setRef] = useState("");
  const [reason, setReason] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const touch = (...f: string[]) => setEdited((prev) => new Set([...prev, ...f]));
  const taka = (p: bigint) => formatTaka(p, locale);
  const e = state.errors ?? {};
  const shownAvail = state.available ? BigInt(state.available) : avail;
  const err = (f: "amount" | "method" | "paymentRef" | "reason") =>
    e[f] && !edited.has(f) ? t(`withdrawErrors.${e[f]}` as "withdrawErrors.server", { amount: taka(shownAvail) }) : undefined;

  const paisa = parseTaka(amount) ?? 0n;
  const over = paisa > avail;
  const quick = [
    { label: t("withdrawForm.all"), value: avail },
    { label: t("withdrawForm.half"), value: avail / 2n },
    ...[500_00n, 1000_00n, 5000_00n].filter((v) => v < avail).map((v) => ({ label: taka(v), value: v })),
  ].filter((q) => q.value > 0n);

  if (avail <= 0n && BigInt(held) === 0n) {
    return (
      <div className="withdraw-form empty">
        <h2>{t("withdrawForm.title")}</h2>
        <p className="muted">{t("withdrawForm.nothing")}</p>
      </div>
    );
  }

  return (
    <form
      id="withdraw"
      className="withdraw-form"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const data = new FormData(ev.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="submitKey" value={submitKey} />
      <input type="hidden" name="method" value={method} />
      <h2>{t("withdrawForm.title")}</h2>

      <div className="avail-pill">
        <span>{t("withdrawForm.available")}</span>
        <strong>{taka(avail)}</strong>
        {BigInt(held) > 0n && <small>{t("withdrawForm.held", { amount: taka(BigInt(held)) })}</small>}
      </div>

      <div className={`field big-amount${err("amount") || (over && paisa > 0n) ? " has-error" : ""}`}>
        <label htmlFor="wd-amount">{t("withdrawForm.amount")}</label>
        <span className="money-input">
          <span aria-hidden="true">৳</span>
          <input
            id="wd-amount"
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            onChange={(ev) => {
              setAmount(ev.target.value);
              touch("amount");
            }}
            aria-invalid={err("amount") || over ? true : undefined}
          />
        </span>
        {err("amount") ? (
          <small className="field-error">{err("amount")}</small>
        ) : over ? (
          <small className="field-error">{t("withdrawErrors.over_balance", { amount: taka(avail) })}</small>
        ) : null}
      </div>
      {quick.length > 0 && (
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
      )}

      <span className="label">{t("withdrawForm.paidBy")}</span>
      <div className="method-tiles" role="radiogroup" aria-label={t("withdrawForm.paidBy")}>
        {METHODS.map((m) => (
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
          <label htmlFor="wd-ref">{t("withdrawForm.ref")}</label>
          <input
            id="wd-ref"
            name="paymentRef"
            value={ref}
            autoComplete="off"
            spellCheck={false}
            placeholder={method === "mobile_wallet" ? "01XXXXXXXXX" : ""}
            onChange={(ev) => {
              setRef(ev.target.value);
              touch("paymentRef");
            }}
          />
          {err("paymentRef") ? (
            <small className="field-error">{err("paymentRef")}</small>
          ) : (
            <small>{method === "mobile_wallet" ? t("withdrawForm.refWallet") : t("withdrawForm.refBank")}</small>
          )}
        </div>
      )}

      <div className={`field${err("reason") ? " has-error" : ""}`}>
        <label htmlFor="wd-reason">{t("withdrawForm.reason")}</label>
        <textarea
          id="wd-reason"
          name="reason"
          rows={2}
          maxLength={300}
          value={reason}
          placeholder={t("withdrawForm.reasonPlaceholder")}
          onChange={(ev) => {
            setReason(ev.target.value);
            touch("reason");
          }}
        />
        {err("reason") && <small className="field-error">{err("reason")}</small>}
      </div>

      <div className="entry-preview mini">
        <span className="label">{t("withdrawForm.preview")}</span>
        <div className="entry-row">
          <span className="side dr">{t("depositForm.debit")}</span>
          <span className="account">
            {t("accounts.member_savings")} · {memberName}
          </span>
          <strong>{taka(paisa)}</strong>
        </div>
        <div className="entry-row">
          <span className="side cr">{t("depositForm.credit")}</span>
          <span className="account">{t(`accounts.${method}`)}</span>
          <strong>{taka(paisa)}</strong>
        </div>
        <p className="muted after-note" key={paisa.toString()}>
          {t("withdrawForm.after", { amount: taka(BigInt(balance) - paisa) })}
        </p>
      </div>

      <p className="approval-note">
        <span aria-hidden="true">🛡️</span> {t("withdrawForm.approvalNote")}
      </p>

      {e.form && (
        <p className="form-error" role="alert" key={state.attempt}>
          {t(`withdrawErrors.${e.form}` as "withdrawErrors.server", { amount: taka(shownAvail) })}
        </p>
      )}
      <button className="btn primary block wd" disabled={pending || paisa <= 0n || over}>
        {pending ? (
          <>
            <span className="spinner" aria-hidden="true" /> {t("withdrawForm.sending")}
          </>
        ) : (
          t("withdrawForm.confirm", { amount: taka(paisa) })
        )}
      </button>
    </form>
  );
}
