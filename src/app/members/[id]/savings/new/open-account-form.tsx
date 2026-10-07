"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatTaka } from "@/lib/format";
import { toTakaDecimal } from "@/lib/money";
import { FREQ_ICON } from "../../../../savings/ui";
import { openAccountAction, type OpenAccountState } from "./actions";

interface ProductOption {
  id: string;
  code: string;
  name: string;
  frequency: "daily" | "weekly" | "monthly" | "flexible";
  /** Paisa as a string; null for flexible. */
  installment: string | null;
  /** The member already has an open account in it. */
  taken: boolean;
}

export function OpenAccountForm({ memberId, memberName, products }: { memberId: string; memberName: string; products: ProductOption[] }) {
  const t = useTranslations("savings");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<OpenAccountState, FormData>(openAccountAction.bind(null, memberId), {});
  const first = products.find((p) => !p.taken);
  const [productId, setProductId] = useState(first?.id ?? "");
  const chosen = products.find((p) => p.id === productId);
  const asInput = (paisa: string | null) => {
    if (!paisa) return "";
    const s = toTakaDecimal(BigInt(paisa)).replace(/\.00$/, "");
    return locale === "bn" ? toBanglaDigits(s) : s;
  };
  const [installment, setInstallment] = useState(asInput(first?.installment ?? null));
  const [seen, setSeen] = useState(state);
  const [edited, setEdited] = useState(false);
  if (seen !== state) {
    setSeen(state);
    setEdited(false);
  }
  const e = state.errors ?? {};
  const errText = (code: string | undefined) =>
    code ? t(`openErrors.${code}` as "openErrors.server", { name: memberName }) : undefined;

  return (
    <form action={action} className="open-account" noValidate>
      <input type="hidden" name="productId" value={productId} />
      <section className="buy-card">
        <span className="label">{t("openForm.product")}</span>
        <div className="product-choices" role="radiogroup" aria-label={t("openForm.product")}>
          {products.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={productId === p.id}
              disabled={p.taken}
              className={`f-${p.frequency}${productId === p.id ? " on" : ""}`}
              onClick={() => {
                setProductId(p.id);
                setInstallment(asInput(p.installment));
                setEdited(true);
              }}
            >
              <span className="freq-emoji" aria-hidden="true">
                {FREQ_ICON[p.frequency]}
              </span>
              <span className="choice-text">
                <strong>{p.name}</strong>
                <small>
                  {p.code} · {t(`every.${p.frequency}`, { amount: p.installment ? formatTaka(BigInt(p.installment), locale) : "" })}
                </small>
              </span>
              {p.taken && <span className="chip">{t("openForm.already")}</span>}
            </button>
          ))}
        </div>
        {!edited && errText(e.productId) && <small className="field-error">{errText(e.productId)}</small>}
      </section>

      {chosen && chosen.frequency !== "flexible" && (
        <section className="buy-card">
          <div className={`field${!edited && e.installment ? " has-error" : ""}`}>
            <label htmlFor="installment">{t("openForm.installment")}</label>
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
                  setEdited(true);
                }}
              />
            </span>
            {!edited && e.installment ? (
              <small className="field-error">{errText(e.installment)}</small>
            ) : (
              <small>{t("openForm.installmentHint")}</small>
            )}
          </div>
        </section>
      )}

      {e.form && (
        <p className="form-error" role="alert" key={state.attempt}>
          {errText(e.form)}
        </p>
      )}
      <div className="form-actions">
        <Link href={`/members/${memberId}`} className="btn ghost">
          {t("openForm.cancel")}
        </Link>
        <button className="btn primary" disabled={pending || !productId}>
          {pending ? t("openForm.saving") : t("openForm.save")}
        </button>
      </div>
    </form>
  );
}
