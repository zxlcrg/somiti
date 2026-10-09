"use client";

import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { saveSomitiAction, type SomitiState } from "./actions";

interface Values {
  nameEn: string;
  nameBn: string;
  defaultLocale: string;
  sharePrice: string;
}

/** The somiti's own details: names, the language people start in, and the share price. */
export function SomitiForm({
  slug,
  businessDate,
  fiscalYear,
  initial,
}: {
  slug: string;
  businessDate: string;
  fiscalYear: string;
  initial: Values;
}) {
  const t = useTranslations("settings");
  const tLang = useTranslations("language");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<SomitiState, FormData>(saveSomitiAction, {});
  const [v, setV] = useState<Values>(initial);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  const [copied, setCopied] = useState(false);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const e = state.errors ?? {};
  const err = (k: keyof Values) => (e[k] && !edited.has(k) ? t(`errors.${e[k]}`) : undefined);
  const set = (k: keyof Values, value: string) => {
    setV((prev) => ({ ...prev, [k]: value }));
    setEdited((prev) => new Set(prev).add(k).add(k === "nameBn" ? "nameEn" : k));
  };

  const price = parseTaka(v.sharePrice);
  const dirty = (Object.keys(initial) as (keyof Values)[]).some((k) => initial[k] !== v[k]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(slug);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the code is on screen to copy by hand.
    }
  }

  return (
    <section className="settings-card somiti-card" aria-labelledby="somiti-title">
      <div className="somiti-banner">
        <div className="somiti-badge" aria-hidden="true">
          {(v.nameBn || v.nameEn || "৳").trim().charAt(0)}
        </div>
        <div className="somiti-banner-text">
          <h2 id="somiti-title">{(locale === "bn" ? v.nameBn || v.nameEn : v.nameEn || v.nameBn) || t("somiti.title")}</h2>
          {v.nameEn && v.nameBn && <p>{locale === "bn" ? v.nameEn : v.nameBn}</p>}
        </div>
      </div>

      <dl className="somiti-facts">
        <div className="fact code">
          <dt>{t("somiti.code")}</dt>
          <dd>
            <code>{slug}</code>
            <button type="button" className={`copy-btn${copied ? " done" : ""}`} onClick={copy}>
              {copied ? `✓ ${t("somiti.copied")}` : t("somiti.copy")}
            </button>
          </dd>
          <small>{t("somiti.codeHint")}</small>
        </div>
        <div className="fact date">
          <dt>{t("somiti.businessDate")}</dt>
          <dd>📅 {businessDate}</dd>
        </div>
        <div className="fact fy">
          <dt>{t("somiti.fiscalYear")}</dt>
          <dd>🗓 {fiscalYear}</dd>
        </div>
      </dl>

      <form
        className="somiti-form"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          const data = new FormData(ev.currentTarget);
          startTransition(() => action(data));
        }}
      >
        {e.form && (
          <p className="form-error" role="alert" key={state.attempt}>
            {t(`errors.${e.form}`)}
          </p>
        )}
        <div className="grid-2">
          <div className={`field${err("nameEn") ? " has-error" : ""}`}>
            <label htmlFor="s-nameEn">{t("somiti.nameEn")}</label>
            <input id="s-nameEn" name="nameEn" value={v.nameEn} onChange={(ev) => set("nameEn", ev.target.value)} autoComplete="off" aria-invalid={!!err("nameEn") || undefined} />
            {err("nameEn") && <small className="field-error">{err("nameEn")}</small>}
          </div>
          <div className={`field${err("nameBn") ? " has-error" : ""}`}>
            <label htmlFor="s-nameBn">{t("somiti.nameBn")}</label>
            <input id="s-nameBn" name="nameBn" lang="bn" value={v.nameBn} onChange={(ev) => set("nameBn", ev.target.value)} autoComplete="off" aria-invalid={!!err("nameBn") || undefined} />
            {err("nameBn") && <small className="field-error">{err("nameBn")}</small>}
          </div>

          <div className="field">
            <span className="label">{t("somiti.defaultLocale")}</span>
            <div className="segmented wide lang-toggle" role="radiogroup" aria-label={t("somiti.defaultLocale")}>
              {(["bn", "en"] as const).map((l) => (
                <label key={l}>
                  <input type="radio" name="defaultLocale" value={l} checked={v.defaultLocale === l} onChange={() => set("defaultLocale", l)} />
                  <span>
                    {l === "bn" ? "অ" : "A"} · {tLang(l)}
                  </span>
                </label>
              ))}
            </div>
            {err("defaultLocale") ? <small className="field-error">{err("defaultLocale")}</small> : <small>{t("somiti.defaultLocaleHint")}</small>}
          </div>

          <div className={`field${err("sharePrice") ? " has-error" : ""}`}>
            <label htmlFor="s-sharePrice">{t("somiti.sharePrice")}</label>
            <div className={`phone-input money${err("sharePrice") ? " is-invalid" : ""}`}>
              <span aria-hidden="true">৳</span>
              <input
                id="s-sharePrice"
                name="sharePrice"
                inputMode="decimal"
                autoComplete="off"
                value={v.sharePrice}
                onChange={(ev) => set("sharePrice", ev.target.value)}
                aria-invalid={!!err("sharePrice") || undefined}
              />
              {price !== null && price > 0n && (
                <em className="price-preview" aria-live="polite">
                  {formatTaka(price, locale)} {t("somiti.perShare")}
                </em>
              )}
            </div>
            {err("sharePrice") ? <small className="field-error">{err("sharePrice")}</small> : <small>{t("somiti.sharePriceHint")}</small>}
          </div>
        </div>

        <div className="form-actions settings-actions">
          {state.notice && !dirty && (
            <span className={`celebrate small${state.notice === "unchanged" ? " quiet" : ""}`} role="status" key={state.attempt}>
              {state.notice === "saved" ? `✓ ${t("somiti.saved")}` : t("somiti.unchanged")}
            </span>
          )}
          <button className="btn primary" disabled={pending}>
            {pending ? (
              <>
                <span className="spinner" aria-hidden="true" /> {t("somiti.saving")}
              </>
            ) : (
              t("somiti.save")
            )}
          </button>
        </div>
      </form>
    </section>
  );
}
