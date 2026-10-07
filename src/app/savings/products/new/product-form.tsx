"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { FREQ_ICON } from "../../ui";
import { createProductAction, type ProductFormState } from "./actions";

const FREQUENCIES = ["daily", "weekly", "monthly", "flexible"] as const;
type Frequency = (typeof FREQUENCIES)[number];
/** Installments a year, for the preview's rough yearly total. */
const PER_YEAR: Record<Frequency, number> = { daily: 365, weekly: 52, monthly: 12, flexible: 0 };

export function ProductForm() {
  const t = useTranslations("savings");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<ProductFormState, FormData>(createProductAction, {});
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [code, setCode] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [installment, setInstallment] = useState("");
  const [nameBn, setNameBn] = useState("");
  const [minDeposit, setMinDeposit] = useState("");
  const [lateFine, setLateFine] = useState("");
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const touch = (f: string) => setEdited((prev) => new Set(prev).add(f));
  const e = state.errors ?? {};
  const err = (f: Exclude<keyof typeof e, "form">) =>
    e[f] && !edited.has(f) ? t(`productErrors.${e[f]}` as "productErrors.required") : undefined;

  const amount = frequency === "flexible" ? null : parseTaka(installment);
  const fine = frequency === "flexible" ? null : parseTaka(lateFine);
  const taka = (p: bigint) => formatTaka(p, locale);

  return (
    <form action={action} className="product-form" noValidate>
      <input type="hidden" name="frequency" value={frequency} />
      <div className="product-form-main">
        <section className="buy-card">
          <span className="label">{t("productForm.frequency")}</span>
          <div className="freq-tiles" role="radiogroup" aria-label={t("productForm.frequency")}>
            {FREQUENCIES.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={frequency === f}
                className={`f-${f}${frequency === f ? " on" : ""}`}
                onClick={() => {
                  setFrequency(f);
                  touch("frequency");
                  touch("installment");
                }}
              >
                <span className="freq-emoji" aria-hidden="true">
                  {FREQ_ICON[f]}
                </span>
                <strong>{t(`frequency.${f}`)}</strong>
                <small>{t(`productForm.frequencyHint.${f}`)}</small>
              </button>
            ))}
          </div>
          {err("frequency") && <small className="field-error">{err("frequency")}</small>}
        </section>

        <section className="buy-card form-grid">
          <div className={`field${err("code") ? " has-error" : ""}`}>
            <label htmlFor="code">{t("productForm.code")}</label>
            <input
              id="code"
              name="code"
              value={code}
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              className="code-input"
              onChange={(ev) => {
                setCode(ev.target.value.toUpperCase());
                touch("code");
              }}
              aria-invalid={err("code") ? true : undefined}
              placeholder="DS"
            />
            {err("code") ? <small className="field-error">{err("code")}</small> : <small>{t("productForm.codeHint")}</small>}
          </div>
          <div className={`field${err("nameEn") ? " has-error" : ""}`}>
            <label htmlFor="nameEn">{t("productForm.nameEn")}</label>
            <input
              id="nameEn"
              name="nameEn"
              value={nameEn}
              maxLength={80}
              onChange={(ev) => {
                setNameEn(ev.target.value);
                touch("nameEn");
              }}
              aria-invalid={err("nameEn") ? true : undefined}
              placeholder="Daily savings"
            />
            {err("nameEn") && <small className="field-error">{err("nameEn")}</small>}
          </div>
          <div className={`field${err("nameBn") ? " has-error" : ""}`}>
            <label htmlFor="nameBn">{t("productForm.nameBn")}</label>
            <input
              id="nameBn"
              name="nameBn"
              lang="bn"
              maxLength={80}
              value={nameBn}
              onChange={(ev) => {
                setNameBn(ev.target.value);
                touch("nameBn");
              }}
              placeholder="দৈনিক সঞ্চয়"
            />
            {err("nameBn") && <small className="field-error">{err("nameBn")}</small>}
          </div>
          {frequency !== "flexible" && (
            <div className={`field${err("installment") ? " has-error" : ""}`}>
              <label htmlFor="installment">{t("productForm.installment")}</label>
              <span className="money-input">
                <span aria-hidden="true">৳</span>
                <input
                  id="installment"
                  name="installment"
                  inputMode="decimal"
                  autoComplete="off"
                  value={installment}
                  onChange={(ev) => {
                    setInstallment(ev.target.value);
                    touch("installment");
                  }}
                  aria-invalid={err("installment") ? true : undefined}
                  placeholder="20"
                />
              </span>
              {err("installment") && <small className="field-error">{err("installment")}</small>}
            </div>
          )}
          {frequency !== "flexible" && (
            <div className={`field${err("lateFine") ? " has-error" : ""}`}>
              <label htmlFor="lateFine">{t("fines.formLabel")}</label>
              <span className="money-input">
                <span aria-hidden="true">৳</span>
                <input
                  id="lateFine"
                  name="lateFine"
                  inputMode="decimal"
                  autoComplete="off"
                  value={lateFine}
                  onChange={(ev) => {
                    setLateFine(ev.target.value);
                    touch("lateFine");
                  }}
                  aria-invalid={err("lateFine") ? true : undefined}
                  placeholder="5"
                />
              </span>
              {err("lateFine") ? <small className="field-error">{err("lateFine")}</small> : <small>{t("fines.formHint")}</small>}
            </div>
          )}
          <div className={`field${err("minDeposit") ? " has-error" : ""}`}>
            <label htmlFor="minDeposit">{t("productForm.minDeposit")}</label>
            <span className="money-input">
              <span aria-hidden="true">৳</span>
              <input
                id="minDeposit"
                name="minDeposit"
                inputMode="decimal"
                autoComplete="off"
                value={minDeposit}
                onChange={(ev) => {
                  setMinDeposit(ev.target.value);
                  touch("minDeposit");
                }}
                placeholder="1"
              />
            </span>
            {err("minDeposit") ? <small className="field-error">{err("minDeposit")}</small> : <small>{t("productForm.minDepositHint")}</small>}
          </div>
        </section>
      </div>

      <aside className="product-preview-wrap">
        <span className="label">{t("productForm.preview")}</span>
        <article className={`product-card preview f-${frequency}`} aria-live="polite">
          <header>
            <span className="product-icon" aria-hidden="true">
              {FREQ_ICON[frequency]}
            </span>
            <span className="product-code">{code.trim() || "—"}</span>
            <span className="freq-pill">{t(`frequency.${frequency}`)}</span>
          </header>
          <h3>{nameEn.trim() || t("productForm.title")}</h3>
          <p className="product-rule">{t(`every.${frequency}`, { amount: amount ? taka(amount) : "৳…" })}</p>
          {amount && amount > 0n && <p className="muted per-year">{t("productForm.perYear", { amount: taka(amount * BigInt(PER_YEAR[frequency])) })}</p>}
          {fine && fine > 0n && (
            <p className="fine-rule">
              <span aria-hidden="true">⏰</span> {t("fines.perInstallment", { amount: taka(fine) })}
            </p>
          )}
        </article>
        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {e.form === "forbidden" ? t("noAccess") : t("productErrors.server")}
          </p>
        )}
        <div className="form-actions">
          <Link href="/savings" className="btn ghost">
            {t("productForm.cancel")}
          </Link>
          <button className="btn primary" disabled={pending}>
            {pending ? t("productForm.saving") : t("productForm.save")}
          </button>
        </div>
      </aside>
    </form>
  );
}
