"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toLatinDigits } from "@/lib/digits";
import { formatInteger, formatTaka } from "@/lib/format";
import { buySharesAction, type BuySharesState } from "./actions";

const QUICK = [1, 5, 10, 25, 50] as const;
const METHODS = [
  { value: "cash", icon: "💵" },
  { value: "bank", icon: "🏦" },
  { value: "mobile_wallet", icon: "📱" },
] as const;
const MAX = 10_000;

export function BuySharesForm({
  memberId,
  memberName,
  pricePaisa,
  heldShares,
  heldPaisa,
}: {
  memberId: string;
  memberName: string;
  pricePaisa: string;
  heldShares: number;
  heldPaisa: string;
}) {
  const t = useTranslations("members.shares");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<BuySharesState, FormData>(buySharesAction.bind(null, memberId), {});
  // One key per visit to this form: a double click or a retry after a lost
  // connection posts once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [count, setCount] = useState("1");
  const [method, setMethod] = useState<(typeof METHODS)[number]["value"]>("cash");
  const [ref, setRef] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }

  const price = BigInt(pricePaisa);
  const digits = toLatinDigits(count).trim();
  const shares = /^\d{1,5}$/.test(digits) ? Math.min(Number(digits), MAX) : 0;
  const amount = BigInt(shares) * price;
  const taka = (p: bigint) => formatTaka(p, locale);
  const e = state.errors ?? {};
  const err = (f: "shares" | "method" | "paymentRef") =>
    e[f] && !edited.has(f) ? t(`errors.${e[f]}` as "errors.server") : undefined;
  const touch = (f: string) => setEdited((prev) => new Set(prev).add(f));

  function setShares(n: number) {
    setCount(String(Math.max(1, Math.min(MAX, n))));
    touch("shares");
  }

  const debitAccount = t(`accounts.${method}`);

  return (
    <form
      className="buy-shares"
      noValidate
      onSubmit={(ev) => {
        ev.preventDefault();
        const data = new FormData(ev.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="method" value={method} />

      <section className="buy-card">
        <label className="label" htmlFor="shares">
          {t("form.howMany")}
        </label>
        <div className={`stepper${err("shares") ? " has-error" : ""}`}>
          <button type="button" onClick={() => setShares(shares - 1)} disabled={shares <= 1} aria-label={t("form.less")}>
            −
          </button>
          <input
            id="shares"
            name="shares"
            inputMode="numeric"
            value={count}
            onChange={(ev) => {
              setCount(ev.target.value);
              touch("shares");
            }}
            autoComplete="off"
          />
          <button type="button" onClick={() => setShares(shares + 1)} disabled={shares >= MAX} aria-label={t("form.more")}>
            +
          </button>
        </div>
        {err("shares") && <small className="field-error">{err("shares")}</small>}
        <div className="quick-picks" role="group" aria-label={t("form.quick")}>
          {QUICK.map((n) => (
            <button key={n} type="button" className={shares === n ? "on" : undefined} onClick={() => setShares(n)}>
              {formatInteger(n, locale)}
            </button>
          ))}
        </div>

        <div className="amount-due" aria-live="polite">
          <span>{t("form.amount")}</span>
          <strong key={amount.toString()}>{taka(amount)}</strong>
          <small>
            {formatInteger(shares, locale)} × {taka(price)}
          </small>
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
              {t(`methods.${m.value}`)}
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
              placeholder={method === "mobile_wallet" ? "8N7A2KQ1XZ" : ""}
            />
            {err("paymentRef") ? (
              <small className="field-error">{err("paymentRef")}</small>
            ) : (
              <small>{method === "mobile_wallet" ? t("form.refWallet") : t("form.refBank")}</small>
            )}
          </div>
        )}
      </section>

      <section className="buy-card entry-preview">
        <span className="label">{t("form.preview")}</span>
        <div className="entry-row">
          <span className="side dr">{t("form.debit")}</span>
          <span className="account">{debitAccount}</span>
          <strong>{taka(amount)}</strong>
        </div>
        <div className="entry-row">
          <span className="side cr">{t("form.credit")}</span>
          <span className="account">
            {t("accounts.share_capital")} · {memberName}
          </span>
          <strong>{taka(amount)}</strong>
        </div>
        <p className="balanced" key={`${amount}-${method}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t("form.balanced")}
        </p>
        <p className="muted after-note">
          {t("form.after", {
            name: memberName,
            count: heldShares + shares,
            amount: taka(BigInt(heldPaisa) + amount),
          })}
        </p>
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
        <button className="btn primary" disabled={pending || shares < 1}>
          {pending ? (
            <>
              <span className="spinner" aria-hidden="true" /> {t("form.posting")}
            </>
          ) : (
            t("form.confirm", { amount: taka(amount) })
          )}
        </button>
      </div>
    </form>
  );
}
