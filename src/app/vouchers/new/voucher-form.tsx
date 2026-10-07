"use client";

import Link from "next/link";
import { startTransition, useActionState, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { parseTaka, toTakaDecimal } from "@/lib/money";
import { submitVoucherAction, type VoucherFormState } from "./actions";

export interface AccountOption {
  id: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  label: string;
}

interface Row {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

type Field = "accountId" | "debit" | "credit" | "memo";
const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
const MAX_ROWS = 50;

const blank = (key: string): Row => ({ key, accountId: "", debit: "", credit: "", memo: "" });

function amount(s: string): bigint {
  return s.trim() ? (parseTaka(s) ?? 0n) : 0n;
}

export function VoucherForm({ accounts, submitKey }: { accounts: AccountOption[]; submitKey: string }) {
  const t = useTranslations("books.form");
  const tType = useTranslations("ledger.accountType");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<VoucherFormState, FormData>(submitVoucherAction, {});
  // Keys must match between the server render and the browser, so they count from a ref, not a global.
  const seq = useRef(2);
  const [rows, setRows] = useState<Row[]>(() => [blank("r1"), blank("r2")]);
  const [narration, setNarration] = useState("");

  // Errors come back by position; remember which rows were sent so they stay on the right row.
  const [sentKeys, setSentKeys] = useState<string[]>([]);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const errorsByKey = new Map(Object.entries(state.errors?.lines ?? {}).map(([i, e]) => [sentKeys[Number(i)], e]));
  const err = (row: Row, f: Field) => {
    const code = errorsByKey.get(row.key)?.[f];
    return code && !edited.has(`${row.key}.${f}`) ? t(`errors.${code}`) : undefined;
  };
  const accountType = new Map(accounts.map((a) => [a.id, a.type]));

  const debits = rows.reduce((s, r) => s + amount(r.debit), 0n);
  const credits = rows.reduce((s, r) => s + amount(r.credit), 0n);
  const diff = debits - credits;
  const balanced = diff === 0n && debits > 0n;
  const max = debits > credits ? debits : credits;
  const width = (v: bigint) => (max > 0n ? `${Number((v * 1000n) / max) / 10}%` : "0%");
  const taka = (p: bigint) => formatTaka(p, locale);
  const asInput = (p: bigint) => {
    const s = toTakaDecimal(p).replace(/\.00$/, "");
    return locale === "bn" ? toBanglaDigits(s) : s;
  };

  function update(key: string, f: Field, value: string) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, [f]: value };
        // A line is a debit or a credit: typing one side clears the other.
        if (f === "debit" && value.trim()) next.credit = "";
        if (f === "credit" && value.trim()) next.debit = "";
        return next;
      }),
    );
    setEdited((prev) => new Set(prev).add(`${key}.${f}`).add(`${key}.debit`).add(`${key}.credit`));
  }

  function balanceWith(key: string) {
    const others = rows.filter((r) => r.key !== key);
    const need = others.reduce((s, r) => s + amount(r.debit) - amount(r.credit), 0n);
    if (need === 0n) return;
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, debit: need < 0n ? asInput(-need) : "", credit: need > 0n ? asInput(need) : "" }
          : r,
      ),
    );
    setEdited((prev) => new Set(prev).add(`${key}.debit`).add(`${key}.credit`));
  }

  const formError = state.errors?.server
    ? t(`errors.${state.errors.server}`)
    : state.errors?.form
      ? t(`errors.${state.errors.form}`)
      : undefined;
  const narrationError = state.errors?.narration && !edited.has("narration") ? t(`errors.narration_${state.errors.narration}`) : undefined;

  return (
    <form
      className="voucher-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSentKeys(rows.map((r) => r.key));
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="submitKey" value={submitKey} />
      <input
        type="hidden"
        name="lines"
        value={JSON.stringify(rows.map(({ accountId, debit, credit, memo }) => ({ accountId, debit, credit, memo })))}
      />

      <div className="voucher-editor">
        <div className={`field${narrationError ? " has-error" : ""}`}>
          <label htmlFor="narration">{t("narration")}</label>
          <textarea
            id="narration"
            name="narration"
            rows={2}
            maxLength={1000}
            value={narration}
            placeholder={t("narrationPlaceholder")}
            aria-invalid={narrationError ? true : undefined}
            onChange={(e) => {
              setNarration(e.target.value);
              setEdited((prev) => new Set(prev).add("narration"));
            }}
          />
          {narrationError && <small className="field-error">{narrationError}</small>}
        </div>

        <div className="line-head" aria-hidden="true">
          <span>{t("account")}</span>
          <span>{t("debit")}</span>
          <span>{t("credit")}</span>
          <span />
        </div>
        <ol className="voucher-lines">
          {rows.map((row, i) => {
            const type = accountType.get(row.accountId);
            const id = (f: string) => `${row.key}-${f}`;
            const empty = !row.debit.trim() && !row.credit.trim();
            const amountError = err(row, "debit") ?? err(row, "credit");
            return (
              <li key={row.key} className={`voucher-line${type ? ` t-${type}` : ""}`}>
                <div className={`cell account${err(row, "accountId") ? " has-error" : ""}`}>
                  <label htmlFor={id("account")} className="sr-only">
                    {t("lineAccount", { n: i + 1 })}
                  </label>
                  <select
                    id={id("account")}
                    value={row.accountId}
                    onChange={(e) => update(row.key, "accountId", e.target.value)}
                    aria-invalid={err(row, "accountId") ? true : undefined}
                  >
                    <option value="">{t("chooseAccount")}</option>
                    {TYPES.map((ty) => (
                      <optgroup key={ty} label={tType(ty)}>
                        {accounts
                          .filter((a) => a.type === ty)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.label}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {err(row, "accountId") && <small className="field-error">{err(row, "accountId")}</small>}
                </div>
                {(["debit", "credit"] as const).map((side) => (
                  <div key={side} className={`cell money ${side}${err(row, side) ? " has-error" : ""}`}>
                    <label htmlFor={id(side)} className="sr-only">
                      {t(side === "debit" ? "lineDebit" : "lineCredit", { n: i + 1 })}
                    </label>
                    <span className="money-input">
                      <span aria-hidden="true">৳</span>
                      <input
                        id={id(side)}
                        inputMode="decimal"
                        autoComplete="off"
                        value={row[side]}
                        placeholder={side === "debit" ? t("debit") : t("credit")}
                        onChange={(e) => update(row.key, side, e.target.value)}
                        aria-invalid={err(row, side) ? true : undefined}
                      />
                    </span>
                  </div>
                ))}
                <div className="cell tools">
                  {empty && diff !== 0n && (
                    <button type="button" className="icon-btn balance" onClick={() => balanceWith(row.key)} title={t("fillDifference")}>
                      <span aria-hidden="true">⇄</span>
                      <span className="sr-only">{t("fillDifference")}</span>
                    </button>
                  )}
                  {rows.length > 2 && (
                    <button
                      type="button"
                      className="icon-btn remove"
                      onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                      title={t("removeLine")}
                    >
                      <span aria-hidden="true">✕</span>
                      <span className="sr-only">{t("removeLine")}</span>
                    </button>
                  )}
                </div>
                {amountError && <small className="field-error line-error">{amountError}</small>}
                <input
                  className="memo"
                  aria-label={t("lineMemo", { n: i + 1 })}
                  value={row.memo}
                  maxLength={500}
                  placeholder={t("memoPlaceholder")}
                  onChange={(e) => update(row.key, "memo", e.target.value)}
                />
              </li>
            );
          })}
        </ol>
        {rows.length < MAX_ROWS && (
          <button type="button" className="btn ghost small add-line" onClick={() => setRows((prev) => [...prev, blank(`r${++seq.current}`)])}>
            ＋ {t("addLine")}
          </button>
        )}
      </div>

      <aside className="voucher-summary">
        <div className={`balance-card${balanced ? " is-balanced" : diff !== 0n ? " is-off" : ""}`} aria-live="polite">
          <div className="bars">
            <div>
              <div className="bar-head">
                <span>{t("totalDebit")}</span>
                <strong>{taka(debits)}</strong>
              </div>
              <div className="bar">
                <div className="bar-fill debit" style={{ width: width(debits) }} />
              </div>
            </div>
            <div>
              <div className="bar-head">
                <span>{t("totalCredit")}</span>
                <strong>{taka(credits)}</strong>
              </div>
              <div className="bar">
                <div className="bar-fill credit" style={{ width: width(credits) }} />
              </div>
            </div>
          </div>
          {balanced ? (
            <p className="balanced">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t("balanced")}
            </p>
          ) : (
            <p className="off-by">{diff === 0n ? t("enterAmounts") : t("difference", { amount: taka(diff < 0n ? -diff : diff) })}</p>
          )}
        </div>
        <p className="checker-note">
          <span aria-hidden="true">🛡</span> {t("checkerNote")}
        </p>
        {formError && (
          <p className="form-error" role="alert" key={state.attempt}>
            {formError}
          </p>
        )}
        <div className="form-actions">
          <Link href="/vouchers" className="btn ghost">
            {t("cancel")}
          </Link>
          <button className="btn primary" disabled={pending}>
            {pending ? t("submitting") : t("submit")}
          </button>
        </div>
      </aside>
    </form>
  );
}
