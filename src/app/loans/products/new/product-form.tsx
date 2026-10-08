"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toLatinDigits } from "@/lib/digits";
import { formatInteger, formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { parsePercent } from "@/modules/loans/percent";
import { buildSchedule, summarize, type LoanFrequency, type LoanMethod } from "@/modules/loans/schedule";
import { createLoanProductAction, type LoanProductState } from "../../actions";

const METHODS: { key: LoanMethod; icon: string }[] = [
  { key: "flat", icon: "📏" },
  { key: "declining", icon: "📉" },
];
const FREQUENCIES: { key: LoanFrequency; icon: string }[] = [
  { key: "weekly", icon: "🗓️" },
  { key: "monthly", icon: "🌙" },
];

type Field = "code" | "nameEn" | "nameBn" | "rate" | "minAmount" | "maxAmount" | "maxInstallments" | "fee" | "method" | "frequency" | "chargeLabel" | "allocation" | "lateFine" | "rebate";

export function LoanProductForm() {
  const t = useTranslations("loans");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<LoanProductState, FormData>(createLoanProductAction, {});
  const [v, setV] = useState<Record<Field, string>>({
    code: "",
    nameEn: "",
    nameBn: "",
    rate: "",
    minAmount: "",
    maxAmount: "",
    maxInstallments: "",
    fee: "",
    lateFine: "",
    rebate: "",
    method: "flat",
    frequency: "monthly",
    chargeLabel: "service_charge",
    allocation: "interest_first",
  });
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const set = (f: Field, value: string) => {
    setV((prev) => ({ ...prev, [f]: value }));
    setEdited((prev) => new Set(prev).add(f));
  };
  const e = state.errors ?? {};
  const err = (f: Field) => (e[f] && !edited.has(f) ? t(`productErrors.${e[f]}`) : undefined);
  const taka = (p: bigint) => formatTaka(p, locale);

  // A worked example: the largest loan over the longest term, so the officer sees what a member would pay.
  const rateBp = parsePercent(v.rate, 10_000);
  const feeBp = v.fee.trim() ? parsePercent(v.fee, 1000) : 0;
  const max = parseTaka(v.maxAmount);
  const lateFine = v.lateFine.trim() ? parseTaka(v.lateFine) : null;
  const nText = toLatinDigits(v.maxInstallments.trim());
  const n = /^\d{1,3}$/.test(nText) ? Number(nText) : 0;
  const example =
    rateBp !== null && max && max > 0n && n >= 1 && n <= 520 && max / BigInt(n) >= 100n
      ? summarize(buildSchedule({ principal: max, method: v.method as LoanMethod, rateBp, frequency: v.frequency as LoanFrequency, installments: n }, "2026-01-01"))
      : null;
  const charge = t(`chargeLabel.${v.chargeLabel as "interest"}`);

  const text = (f: Field, opts: { placeholder?: string; money?: boolean; suffix?: string; lang?: string; hint?: string; max?: number }) => (
    <div className={`field${err(f) ? " has-error" : ""}`}>
      <label htmlFor={f}>{t(`productForm.${f}` as "productForm.code")}</label>
      {opts.money || opts.suffix ? (
        <span className={opts.money ? "money-input" : "suffix-input"}>
          {opts.money && <span aria-hidden="true">৳</span>}
          <input
            id={f}
            name={f}
            inputMode="decimal"
            autoComplete="off"
            value={v[f]}
            onChange={(ev) => set(f, ev.target.value)}
            aria-invalid={err(f) ? true : undefined}
            placeholder={opts.placeholder}
          />
          {opts.suffix && <span aria-hidden="true">{opts.suffix}</span>}
        </span>
      ) : (
        <input
          id={f}
          name={f}
          lang={opts.lang}
          maxLength={opts.max}
          autoComplete="off"
          value={v[f]}
          className={f === "code" ? "code-input" : undefined}
          onChange={(ev) => set(f, f === "code" ? ev.target.value.toUpperCase() : ev.target.value)}
          aria-invalid={err(f) ? true : undefined}
          placeholder={opts.placeholder}
        />
      )}
      {err(f) ? <small className="field-error">{err(f)}</small> : opts.hint ? <small>{opts.hint}</small> : null}
    </div>
  );

  const tiles = <K extends string>(f: Field, items: { key: K; icon: string }[], label: string, prefix: string) => (
    <div className="choice-group">
      <span className="label">{label}</span>
      <div className="choice-tiles" role="radiogroup" aria-label={label}>
        {items.map((it) => (
          <button key={it.key} type="button" role="radio" aria-checked={v[f] === it.key} className={`choice c-${it.key}${v[f] === it.key ? " on" : ""}`} onClick={() => set(f, it.key)}>
            <span className="choice-icon" aria-hidden="true">
              {it.icon}
            </span>
            <strong>{t(`${prefix}.${it.key}` as "method.flat")}</strong>
            <small>{t(`${prefix}Hint.${it.key}` as "methodHint.flat")}</small>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <form action={action} className="loan-product-form" noValidate>
      <input type="hidden" name="method" value={v.method} />
      <input type="hidden" name="frequency" value={v.frequency} />
      <input type="hidden" name="chargeLabel" value={v.chargeLabel} />
      <input type="hidden" name="allocation" value={v.allocation} />
      <div className="lpf-main">
        <section className="loan-card">
          {tiles("method", METHODS, t("productForm.method"), "method")}
          {tiles("frequency", FREQUENCIES, t("productForm.frequency"), "frequency")}
          <div className="choice-group">
            <span className="label">{t("productForm.chargeLabel")}</span>
            <div className="seg" role="radiogroup" aria-label={t("productForm.chargeLabel")}>
              {(["service_charge", "interest"] as const).map((c) => (
                <button key={c} type="button" role="radio" aria-checked={v.chargeLabel === c} className={v.chargeLabel === c ? "on" : undefined} onClick={() => set("chargeLabel", c)}>
                  {t(`chargeLabel.${c}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="choice-group">
            <span className="label">{t("productForm.allocation")}</span>
            <div className="seg" role="radiogroup" aria-label={t("productForm.allocation")}>
              {(["interest_first", "principal_first"] as const).map((a) => (
                <button key={a} type="button" role="radio" aria-checked={v.allocation === a} className={v.allocation === a ? "on" : undefined} onClick={() => set("allocation", a)}>
                  {t(`allocation.${a}`, { charge })}
                </button>
              ))}
            </div>
            <small className="muted">{t("productForm.allocationHint")}</small>
          </div>
        </section>
        <section className="loan-card form-grid">
          {text("code", { placeholder: "GL", hint: t("productForm.codeHint"), max: 12 })}
          {text("nameEn", { placeholder: "General loan", max: 80 })}
          {text("nameBn", { placeholder: "সাধারণ ঋণ", lang: "bn", max: 80 })}
          {text("rate", { placeholder: "12", suffix: t("productForm.perYearSuffix"), hint: t("productForm.rateHint") })}
          {text("minAmount", { placeholder: "5,000", money: true })}
          {text("maxAmount", { placeholder: "1,00,000", money: true })}
          {text("maxInstallments", { placeholder: v.frequency === "weekly" ? "46" : "12", hint: t(`productForm.installmentsHint.${v.frequency as "weekly"}`) })}
          {text("fee", { placeholder: "1", suffix: "%", hint: t("productForm.feeHint") })}
          {text("lateFine", { placeholder: "50", money: true, hint: t("productForm.lateFineHint") })}
          {text("rebate", { placeholder: "50", suffix: "%", hint: t("productForm.rebateHint", { charge: charge.toLowerCase() }) })}
        </section>
      </div>

      <aside className="lpf-side">
        <div className={`loan-card example-card m-${v.method}`}>
          <span className="label">{t("productForm.example")}</span>
          {example ? (
            <>
              <p className="example-lead">{t("productForm.exampleLead", { amount: taka(max!), n: formatInteger(n, locale), count: n, frequency: t(`frequency.${v.frequency as "weekly"}`) })}</p>
              <div className="example-figure">
                <span>{t("productForm.eachInstallment")}</span>
                <strong>{taka(example.installment)}</strong>
              </div>
              <dl className="example-rows">
                <div>
                  <dt>{t("productForm.totalCharge", { label: charge })}</dt>
                  <dd>{taka(example.totalInterest)}</dd>
                </div>
                <div>
                  <dt>{t("productForm.totalRepay")}</dt>
                  <dd>{taka(example.totalRepayable)}</dd>
                </div>
                {lateFine !== null && lateFine > 0n && (
                  <div>
                    <dt>{t("productForm.lateFineEach")}</dt>
                    <dd>{taka(lateFine)}</dd>
                  </div>
                )}
                {feeBp !== null && feeBp > 0 && (
                  <div>
                    <dt>{t("productForm.feeTaken")}</dt>
                    <dd>{taka((max! * BigInt(feeBp) + 5000n) / 10000n)}</dd>
                  </div>
                )}
              </dl>
              <p className="muted small-note">{t(`methodHint.${v.method as "flat"}`)}</p>
            </>
          ) : (
            <p className="muted">{t("productForm.exampleEmpty")}</p>
          )}
        </div>
        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {t(`productErrors.${e.form}`)}
          </p>
        )}
        <button className="btn primary block" disabled={pending}>
          {pending ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">＋</span>} {t("productForm.save")}
        </button>
      </aside>
    </form>
  );
}
