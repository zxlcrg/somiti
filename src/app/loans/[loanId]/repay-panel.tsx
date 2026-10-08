"use client";

import { useActionState, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatInteger, formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { allocate, lateFineFor, outstanding, settlementQuote, standing, type Allocation, type InstallmentState } from "@/modules/loans/allocate";
import { repayLoanAction, type RepayState } from "../actions";
import { METHOD_ICON } from "../ui-client";

export interface SerialRow {
  seq: number;
  dueOn: string;
  principal: string;
  interest: string;
  paidPrincipal: string;
  paidInterest: string;
  rebated: string;
  movedPrincipal: string;
  movedInterest: string;
}

/** The cashier's (or a collector's) repayment form, with the split it will post. */
export function RepayPanel({
  loanId,
  rows: raw,
  allocation,
  today,
  channel,
  charge,
  lateFine: lateFineRaw,
  fined,
  rebateBp,
}: {
  loanId: string;
  rows: SerialRow[];
  allocation: Allocation;
  today: string;
  channel: "office" | "collector";
  charge: string;
  lateFine: string | null;
  fined: number[];
  rebateBp: number;
}) {
  const t = useTranslations("loans");
  const l = useLocale();
  const locale = isLocale(l) ? l : defaultLocale;
  const [state, action, pending] = useActionState<RepayState, FormData>(repayLoanAction.bind(null, loanId), {});
  const [key] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "bank" | "mobile_wallet">("cash");
  const [confirming, setConfirming] = useState(false);
  const [edited, setEdited] = useState(false);
  const [waive, setWaive] = useState(false);
  const [settle, setSettle] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setConfirming(false);
    setEdited(false);
  }

  const rows = useMemo<InstallmentState[]>(
    () =>
      raw.map((r) => ({
        seq: r.seq,
        dueOn: r.dueOn,
        principal: BigInt(r.principal),
        interest: BigInt(r.interest),
        paidPrincipal: BigInt(r.paidPrincipal),
        paidInterest: BigInt(r.paidInterest),
        rebated: BigInt(r.rebated),
        movedPrincipal: BigInt(r.movedPrincipal),
        movedInterest: BigInt(r.movedInterest),
      })),
    [raw],
  );
  const owed = outstanding(rows);
  const st = standing(rows, today);
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const digits = (s: string) => (locale === "bn" ? s.replace(/[0-9]/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]!) : s);
  const asTyped = (p: bigint) => digits(p % 100n === 0n ? String(p / 100n) : `${p / 100n}.${String(p % 100n).padStart(2, "0")}`);

  // Settling early only pays off something when the product lets charge off and some installments are still to come.
  const quote = channel === "office" && rebateBp > 0 ? settlementQuote(rows, today, rebateBp) : null;
  const canSettle = quote !== null && quote.rebate > 0n;
  const settling = settle && canSettle;
  const paisa = settling ? quote.total : parseTaka(amount);
  const lines = settling ? quote.lines : paisa !== null ? allocate(rows, paisa, allocation) : null;
  const split = lines
    ? { principal: lines.reduce((s, x) => s + x.principal, 0n), interest: lines.reduce((s, x) => s + x.interest, 0n), first: lines[0]!.seq, last: lines.at(-1)!.seq }
    : null;
  const late = lines ? lateFineFor(rows, lines, today, lateFineRaw ? BigInt(lateFineRaw) : null, fined) : { seqs: [], fine: 0n };
  const fine = waive && channel === "office" ? 0n : late.fine;
  const takeIn = paisa !== null && split ? paisa + fine : null;
  const tooMuch = !settling && paisa !== null && paisa > owed.total;

  const quick: { key: string; label: string; value: bigint }[] = [];
  if (st.dueNow > 0n) quick.push({ key: "due", label: t("repay.quick.due"), value: st.dueNow });
  if (st.next && st.next.amount !== st.dueNow) quick.push({ key: "next", label: t("repay.quick.next", { n: num(st.next.seq) }), value: st.next.amount });
  if (!quick.some((q) => q.value === owed.total)) quick.push({ key: "all", label: t("repay.quick.all"), value: owed.total });
  const pick = (value: string) => {
    setAmount(value);
    setSettle(false);
    setEdited(true);
    setConfirming(false);
  };

  const e = state.errors ?? {};
  const fieldErr = !edited && e.amount ? t(`repayErrors.${e.amount}`, { owed: taka(BigInt(state.owed ?? "0")) }) : null;
  const methods = channel === "collector" ? (["cash"] as const) : (["cash", "bank", "mobile_wallet"] as const);

  return (
    <section className="loan-card step-card repay">
      <h2>
        <span aria-hidden="true">🧾</span> {t("repay.title")}
      </h2>
      <dl className="repay-owed">
        <div className={st.dueNow > 0n ? "hot" : undefined}>
          <dt>{st.overdueCount > 0 ? t("repay.overdue", { n: num(st.overdueCount), count: st.overdueCount }) : t("repay.dueNow")}</dt>
          <dd>{taka(st.dueNow)}</dd>
        </div>
        <div>
          <dt>{t("repay.owed")}</dt>
          <dd>{taka(owed.total)}</dd>
        </div>
      </dl>
      <form
        action={action}
        className="step-form"
        noValidate
        onSubmit={(ev) => {
          if (!confirming) {
            ev.preventDefault();
            if (split) setConfirming(true);
          }
        }}
      >
        <input type="hidden" name="idempotencyKey" value={key} />
        <input type="hidden" name="method" value={method} />
        {waive && late.fine > 0n && <input type="hidden" name="waiveFine" value="1" />}
        {settling && <input type="hidden" name="settle" value="1" />}
        <div className={`field${fieldErr || tooMuch ? " has-error" : ""}`}>
          <label htmlFor="repayAmount">{t("repay.amount")}</label>
          <span className="money-input big">
            <span aria-hidden="true">৳</span>
            <input
              id="repayAmount"
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              value={settling ? asTyped(quote.total) : amount}
              onChange={(ev) => pick(ev.target.value)}
              aria-invalid={fieldErr || tooMuch ? true : undefined}
            />
          </span>
          {settling ? (
            <small className="settle-note">{t("repay.settleNote", { percent: `${digits(String(rebateBp / 100))}%`, charge: charge.toLowerCase() })}</small>
          ) : tooMuch ? (
            <small className="field-error">{t("repayErrors.too_much", { owed: taka(owed.total) })}</small>
          ) : fieldErr ? (
            <small className="field-error">{fieldErr}</small>
          ) : null}
          <div className="quick-amounts">
            {quick.map((q) => (
              <button
                key={q.key}
                type="button"
                className="chip-btn"
                aria-pressed={!settling && paisa === q.value}
                onClick={() => pick(asTyped(q.value))}
              >
                {q.label} · {taka(q.value)}
              </button>
            ))}
            {canSettle && (
              <button
                type="button"
                className={`chip-btn settle-chip${settling ? " on" : ""}`}
                aria-pressed={settling}
                onClick={() => {
                  setSettle(!settling);
                  setEdited(true);
                  setConfirming(false);
                }}
              >
                <span aria-hidden="true">🏁</span> {t("repay.quick.settle")} · {taka(quote.total)}
              </button>
            )}
          </div>
        </div>

        {methods.length > 1 ? (
          <>
            <span className="label">{t("repay.paidBy")}</span>
            <div className="method-tiles" role="radiogroup" aria-label={t("repay.paidBy")}>
              {methods.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? "on" : undefined} onClick={() => setMethod(m)}>
                  <span aria-hidden="true">{METHOD_ICON[m]}</span>
                  {t(`steps.method.${m}`)}
                </button>
              ))}
            </div>
            {method !== "cash" && (
              <div className="field ref-field">
                <label htmlFor="repayRef">{t(`steps.ref.${method}`)}</label>
                <input id="repayRef" name="paymentRef" maxLength={64} autoComplete="off" />
                {e.paymentRef && <small className="field-error">{t(`repayErrors.${e.paymentRef}`, { owed: "" })}</small>}
              </div>
            )}
          </>
        ) : (
          <p className="muted small-note">
            <span aria-hidden="true">👜</span> {t("repay.collectorNote")}
          </p>
        )}

        {split && (
          <div className="repay-split" aria-live="polite">
            <span className="label">{t("repay.goesTo")}</span>
            <div className="split-bar">
              <span className="principal" style={{ width: `${Number((split.principal * 1000n) / paisa!) / 10}%` }} />
              <span className="charge" style={{ width: `${Number((split.interest * 1000n) / paisa!) / 10}%` }} />
            </div>
            <dl className="example-rows">
              <div>
                <dt>
                  <i className="dot principal" aria-hidden="true" /> {t("schedule.principal")}
                </dt>
                <dd>{taka(split.principal)}</dd>
              </div>
              <div>
                <dt>
                  <i className="dot charge" aria-hidden="true" /> {charge}
                </dt>
                <dd>{taka(split.interest)}</dd>
              </div>
              <div className="total">
                <dt>{split.first === split.last ? t("repay.covers.one", { n: num(split.first) }) : t("repay.covers.many", { a: num(split.first), b: num(split.last) })}</dt>
                <dd />
              </div>
              {settling && (
                <div className="rebate-row">
                  <dt>
                    <span aria-hidden="true">🎁</span> {t("repay.rebate", { charge: charge.toLowerCase() })}
                  </dt>
                  <dd>− {taka(quote.rebate)}</dd>
                </div>
              )}
              <div className="hand">
                <dt>{settling || paisa === owed.total ? t("repay.closes") : t("repay.after")}</dt>
                <dd>{settling || paisa === owed.total ? "🎉" : taka(owed.total - paisa!)}</dd>
              </div>
            </dl>
            {late.fine > 0n && (
              <div className={`lf-box${fine === 0n ? " waived" : ""}`}>
                <div className="lf-line">
                  <span>
                    <span aria-hidden="true">⏰</span> {t("repay.fine", { n: num(late.seqs.length), count: late.seqs.length })}
                  </span>
                  <strong>{fine === 0n ? t("repay.fineWaived") : `+ ${taka(late.fine)}`}</strong>
                </div>
                {channel === "office" && (
                  <label className="waive-check">
                    <input type="checkbox" checked={waive} onChange={(ev) => { setWaive(ev.target.checked); setConfirming(false); }} />
                    {t("repay.waive")}
                  </label>
                )}
                <div className="lf-line total">
                  <span>{t("repay.takeIn")}</span>
                  <strong>{taka(takeIn!)}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {t(`repayErrors.${e.form}`, { owed: "" })}
          </p>
        )}
        {confirming && split ? (
          <div className="confirm-close" role="alertdialog" aria-labelledby="confirm-repay">
            <strong id="confirm-repay">{t("repay.confirm", { amount: taka(takeIn!) })}</strong>
            <p>{t("repay.confirmBody")}</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={pending}>
                {t("steps.back")}
              </button>
              <button className="btn primary" disabled={pending} autoFocus>
                {pending ? <span className="spinner" aria-hidden="true" /> : null} {t("repay.submitNow")}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary block" disabled={!split}>
            <span aria-hidden="true">🧾</span> {split ? t("repay.submit", { amount: taka(takeIn!) }) : t("repay.submitEmpty")}
          </button>
        )}
      </form>
    </section>
  );
}
