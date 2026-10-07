"use client";

import { useActionState, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toLatinDigits } from "@/lib/digits";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { applyBasisPoints, parseTaka } from "@/lib/money";
import { buildSchedule, summarize, type LoanFrequency, type LoanMethod } from "@/modules/loans/schedule";
import { applyForLoanAction, type ApplyState } from "../actions";

interface Product {
  id: string;
  code: string;
  name: string;
  method: LoanMethod;
  chargeLabel: "interest" | "service_charge";
  rateBp: number;
  frequency: LoanFrequency;
  minAmount: string;
  maxAmount: string;
  maxInstallments: number;
  processingFeeBp: number;
}

const SHOWN_ROWS = 6;

function pct(bp: number, digits: (s: string) => string) {
  const s = (bp / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${digits(s)}%`;
}

export function ApplyForm({ memberId, products, openProductIds, today }: { memberId: string; products: Product[]; openProductIds: string[]; today: string }) {
  const t = useTranslations("loans");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<ApplyState, FormData>(applyForLoanAction.bind(null, memberId), {});
  const firstFree = products.find((p) => !openProductIds.includes(p.id)) ?? products[0]!;
  const [productId, setProductId] = useState(firstFree.id);
  const [amount, setAmount] = useState("");
  const [installments, setInstallments] = useState(String(Math.min(12, firstFree.maxInstallments)));
  const [purpose, setPurpose] = useState("");
  const [submitKey] = useState(() => crypto.randomUUID());
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const touch = (f: string) => setEdited((prev) => new Set(prev).add(f));
  const e = state.errors ?? {};
  const err = (f: "amount" | "installments" | "purpose" | "productId") => (e[f] && !edited.has(f) ? t(`applyErrors.${e[f]}`) : undefined);

  const taka = (p: bigint | string) => formatTaka(BigInt(p), locale);
  const num = (n: number) => formatInteger(n, locale);
  const digits = (s: string) => (locale === "bn" ? s.replace(/[0-9]/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]!) : s);
  const p = products.find((x) => x.id === productId)!;
  const principal = parseTaka(amount);
  const nText = toLatinDigits(installments.trim());
  const n = /^\d{1,3}$/.test(nText) ? Number(nText) : 0;
  const inRange = principal !== null && principal >= BigInt(p.minAmount) && principal <= BigInt(p.maxAmount);
  const okTerm = n >= 1 && n <= p.maxInstallments;

  const preview = useMemo(() => {
    if (!inRange || !okTerm || principal! / BigInt(n) < 100n) return null;
    const rows = buildSchedule({ principal: principal!, method: p.method, rateBp: p.rateBp, frequency: p.frequency, installments: n }, today);
    const fee = applyBasisPoints(principal!, BigInt(p.processingFeeBp));
    return { rows, sum: summarize(rows), fee };
  }, [inRange, okTerm, principal, n, p, today]);
  const charge = t(`chargeLabel.${p.chargeLabel}`);
  const minPlaceholder = digits(String(BigInt(p.minAmount) / 100n));
  const share = preview ? Number((preview.sum.totalInterest * 1000n) / preview.sum.totalRepayable) / 10 : 0;
  const quick = [p.minAmount, ((BigInt(p.minAmount) + BigInt(p.maxAmount)) / 2n / 100_000n) * 100_000n, p.maxAmount]
    .map((x) => BigInt(x))
    .filter((x, i, all) => x >= BigInt(p.minAmount) && all.indexOf(x) === i);

  return (
    <form action={action} className="apply-form" noValidate>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="submitKey" value={submitKey} />
      <div className="apply-main">
        <section className="loan-card">
          <span className="label">{t("apply.product")}</span>
          <div className="product-picks" role="radiogroup" aria-label={t("apply.product")}>
            {products.map((x) => {
              const busy = openProductIds.includes(x.id);
              return (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={productId === x.id}
                  className={`product-pick m-${x.method}${productId === x.id ? " on" : ""}${busy ? " busy" : ""}`}
                  onClick={() => {
                    setProductId(x.id);
                    touch("productId");
                    if (n > x.maxInstallments) setInstallments(String(x.maxInstallments));
                  }}
                >
                  <span className="product-code">{x.code}</span>
                  <strong>{x.name}</strong>
                  <small>
                    {pct(x.rateBp, digits)} · {t(`method.${x.method}`)} · {t(`frequency.${x.frequency}`)}
                  </small>
                  {busy && <small className="busy-note">{t("apply.alreadyOpen")}</small>}
                </button>
              );
            })}
          </div>
          {err("productId") && <small className="field-error">{err("productId")}</small>}
        </section>

        <section className="loan-card form-grid">
          <div className={`field${err("amount") ? " has-error" : ""}`}>
            <label htmlFor="amount">{t("apply.amount")}</label>
            <span className="money-input big">
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
                placeholder={minPlaceholder}
              />
            </span>
            {err("amount") ? (
              <small className="field-error">{err("amount")}</small>
            ) : (
              <small>{t("apply.range", { min: taka(p.minAmount), max: taka(p.maxAmount) })}</small>
            )}
            <div className="quick-amounts">
              {quick.map((q) => (
                <button key={q.toString()} type="button" className="chip-btn" onClick={() => setAmount(digits(String(q / 100n)))}>
                  {taka(q)}
                </button>
              ))}
            </div>
          </div>
          <div className={`field${err("installments") ? " has-error" : ""}`}>
            <label htmlFor="installments">{t(`apply.installments.${p.frequency}`)}</label>
            <div className="term-row">
              <input
                type="range"
                min={1}
                max={p.maxInstallments}
                value={okTerm ? n : 1}
                aria-label={t(`apply.installments.${p.frequency}`)}
                onChange={(ev) => {
                  setInstallments(ev.target.value);
                  touch("installments");
                }}
              />
              <input
                id="installments"
                name="installments"
                inputMode="numeric"
                className="term-input"
                value={installments}
                onChange={(ev) => {
                  setInstallments(ev.target.value);
                  touch("installments");
                }}
                aria-invalid={err("installments") ? true : undefined}
              />
            </div>
            {err("installments") ? (
              <small className="field-error">{err("installments")}</small>
            ) : (
              <small>{t("apply.termHint", { n: num(p.maxInstallments) })}</small>
            )}
          </div>
          <div className={`field wide${err("purpose") ? " has-error" : ""}`}>
            <label htmlFor="purpose">{t("apply.purpose")}</label>
            <input
              id="purpose"
              name="purpose"
              maxLength={300}
              value={purpose}
              onChange={(ev) => {
                setPurpose(ev.target.value);
                touch("purpose");
              }}
              placeholder={t("apply.purposePlaceholder")}
            />
            {err("purpose") && <small className="field-error">{err("purpose")}</small>}
          </div>
        </section>

        {preview && (
          <section className="loan-card">
            <h2>{t("apply.scheduleTitle")}</h2>
            <div className="table-wrap">
              <table className="ledger-table schedule-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>{t("schedule.due")}</th>
                    <th className="num">{t("schedule.principal")}</th>
                    <th className="num">{charge}</th>
                    <th className="num">{t("schedule.total")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, SHOWN_ROWS).map((r) => (
                    <tr key={r.seq}>
                      <td className="num muted">{num(r.seq)}</td>
                      <td>{formatDate(r.dueOn, locale)}</td>
                      <td className="num">{taka(r.principal)}</td>
                      <td className="num">{taka(r.interest)}</td>
                      <td className="num">
                        <strong>{taka(r.principal + r.interest)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > SHOWN_ROWS && (
              <p className="muted small-note">
                {t("apply.moreRows", { n: num(preview.rows.length - SHOWN_ROWS), last: formatDate(preview.rows.at(-1)!.dueOn, locale) })}
              </p>
            )}
          </section>
        )}
      </div>

      <aside className="apply-side">
        <div className={`loan-card terms-card m-${p.method}`}>
          <span className="label">{t("apply.summary")}</span>
          {preview ? (
            <>
              <div className="terms-figure">
                <span>{t(`apply.each.${p.frequency}`)}</span>
                <strong>{taka(preview.sum.installment)}</strong>
                {preview.sum.lastInstallment !== preview.sum.installment && (
                  <small className="muted">{t("apply.lastOne", { amount: taka(preview.sum.lastInstallment) })}</small>
                )}
              </div>
              <div className="split-bar" role="img" aria-label={t("apply.splitLabel", { principal: taka(principal!), charge: taka(preview.sum.totalInterest) })}>
                <span className="principal" style={{ width: `${100 - share}%` }} />
                <span className="charge" style={{ width: `${share}%` }} />
              </div>
              <dl className="example-rows">
                <div>
                  <dt>
                    <i className="dot principal" aria-hidden="true" /> {t("schedule.principal")}
                  </dt>
                  <dd>{taka(principal!)}</dd>
                </div>
                <div>
                  <dt>
                    <i className="dot charge" aria-hidden="true" /> {charge} ({pct(p.rateBp, digits)})
                  </dt>
                  <dd>{taka(preview.sum.totalInterest)}</dd>
                </div>
                <div className="total">
                  <dt>{t("apply.totalRepay")}</dt>
                  <dd>{taka(preview.sum.totalRepayable)}</dd>
                </div>
                {preview.fee > 0n && (
                  <div>
                    <dt>{t("apply.fee", { rate: pct(p.processingFeeBp, digits) })}</dt>
                    <dd>−{taka(preview.fee)}</dd>
                  </div>
                )}
                <div className="hand">
                  <dt>{t("apply.handedOver")}</dt>
                  <dd>{taka(principal! - preview.fee)}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="muted">{t("apply.summaryEmpty")}</p>
          )}
        </div>
        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {t(`applyErrors.${e.form}`)}
          </p>
        )}
        <button className="btn primary block" disabled={pending}>
          {pending ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">📝</span>} {t("apply.submit")}
        </button>
        <p className="muted small-note">{t("apply.nextStep")}</p>
      </aside>
    </form>
  );
}
