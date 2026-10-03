"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits, toLatinDigits } from "@/lib/digits";
import { formatInteger } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import { formatBdPhone, normalizeBdPhone } from "@/lib/phone";
import { MemberAvatar, memberHue } from "../member-avatar";
import { admitAction, type AdmitState } from "./actions";

type Values = Record<string, string>;

/** Fields that make a complete KYC record, beyond the required ones. */
const COMPLETENESS = ["nameEn", "nameBn", "guardianName", "phone", "nid", "dateOfBirth", "address"] as const;

function Field({
  name,
  label,
  hint,
  error,
  required,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label htmlFor={name}>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      {children}
      {error ? (
        <small className="field-error" id={`${name}-error`}>
          {error}
        </small>
      ) : (
        hint && <small>{hint}</small>
      )}
    </div>
  );
}

export function AdmitForm({ nextNo, businessDate, businessDateLabel }: { nextNo: number; businessDate: string; businessDateLabel: string }) {
  const t = useTranslations("members");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<AdmitState, FormData>(admitAction, {});
  const initial: Values = { guardianRelation: "father", commLocale: "", admissionDate: businessDate, ...state.values };
  const [v, setV] = useState<Values>(initial);
  // An error disappears as soon as its field is edited; a new submit brings back whatever still fails.
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    setEdited(new Set());
  }
  const e = state.errors ?? {};
  const err = (field: keyof typeof e) =>
    e[field] && !edited.has(field) ? t(`errors.${e[field]}` as "errors.invalid") : undefined;

  const phone = normalizeBdPhone(v.phone ?? "");
  const nidDigits = toLatinDigits(v.nid ?? "").replace(/\D/g, "");
  const filled = {
    nameEn: !!v.nameEn?.trim(),
    nameBn: !!v.nameBn?.trim(),
    guardianName: !!(v.guardianNameEn?.trim() || v.guardianNameBn?.trim()),
    phone: !!phone,
    nid: [10, 13, 17].includes(nidDigits.length),
    dateOfBirth: !!v.dateOfBirth,
    address: !!v.address?.trim(),
  };
  const done = COMPLETENESS.filter((k) => filled[k]).length;
  const pct = Math.round((done / COMPLETENESS.length) * 100);
  const preview = { nameEn: v.nameEn?.trim() || null, nameBn: v.nameBn?.trim() || null, memberNo: nextNo };
  const guardian = { nameEn: v.guardianNameEn?.trim() || null, nameBn: v.guardianNameBn?.trim() || null };
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);

  return (
    <div className="admit">
      <form
        action={action}
        className="admit-form"
        noValidate
        onChange={(ev) => {
          setV(Object.fromEntries(new FormData(ev.currentTarget)) as Values);
          const target: EventTarget = ev.target;
          if (target instanceof HTMLInputElement && target.name) {
            // "Enter it in English or Bangla" errors sit on the English field; typing either script answers them.
            const partner: Record<string, string> = { nameBn: "nameEn", guardianNameBn: "guardianNameEn" };
            setEdited((prev) => {
              const next = new Set(prev).add(target.name);
              if (partner[target.name]) next.add(partner[target.name]!);
              return next;
            });
          }
        }}
      >
        {(e.form === "server" || e.form === "forbidden") && (
          <p className="form-error" role="alert">
            {e.form === "server" ? t("errors.server") : t("noAccess")}
          </p>
        )}

        <fieldset className="form-section">
          <legend>
            <span className="step">1</span> {t("form.identity")}
          </legend>
          <div className="grid-2">
            <Field name="nameEn" label={t("form.nameEn")} error={err("nameEn")} hint={t("form.nameHint")}>
              <input id="nameEn" name="nameEn" defaultValue={initial.nameEn} autoComplete="off" lang="en" autoFocus />
            </Field>
            <Field name="nameBn" label={t("form.nameBn")} error={err("nameBn")}>
              <input id="nameBn" name="nameBn" defaultValue={initial.nameBn} autoComplete="off" lang="bn" />
            </Field>
          </div>
          <div className="guardian">
            <div className="guardian-head">
              <span className="label">{t("form.guardian")}</span>
              <div className="segmented" role="radiogroup" aria-label={t("form.guardian")}>
                {(["father", "husband"] as const).map((r) => (
                  <label key={r}>
                    <input type="radio" name="guardianRelation" value={r} defaultChecked={initial.guardianRelation === r} />
                    <span>{t(`form.${r}`)}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid-2">
              <Field name="guardianNameEn" label={t("form.guardianEn")} error={err("guardianNameEn")}>
                <input id="guardianNameEn" name="guardianNameEn" defaultValue={initial.guardianNameEn} autoComplete="off" lang="en" />
              </Field>
              <Field name="guardianNameBn" label={t("form.guardianBn")} error={err("guardianNameBn")}>
                <input id="guardianNameBn" name="guardianNameBn" defaultValue={initial.guardianNameBn} autoComplete="off" lang="bn" />
              </Field>
            </div>
          </div>
        </fieldset>

        <fieldset className="form-section">
          <legend>
            <span className="step">2</span> {t("form.contact")}
          </legend>
          <div className="grid-2">
            <Field name="phone" label={t("form.phone")} required error={err("phone")} hint={t("form.phoneHint")}>
              <div className={`phone-input${err("phone") ? " is-invalid" : ""}`}>
                <span aria-hidden="true">+88</span>
                <input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={initial.phone} placeholder="017XX-XXXXXX" />
              </div>
            </Field>
            <Field name="address" label={t("form.address")} error={err("address")}>
              <input id="address" name="address" defaultValue={initial.address} autoComplete="off" />
            </Field>
          </div>
        </fieldset>

        <fieldset className="form-section">
          <legend>
            <span className="step">3</span> {t("form.kyc")}
          </legend>
          <div className="grid-2">
            <Field name="nid" label={t("form.nid")} error={err("nid")} hint={t("form.nidHint")}>
              <input id="nid" name="nid" inputMode="numeric" defaultValue={initial.nid} autoComplete="off" />
            </Field>
            <Field name="dateOfBirth" label={t("form.dob")} error={err("dateOfBirth")}>
              <input id="dateOfBirth" name="dateOfBirth" type="date" max={businessDate} defaultValue={initial.dateOfBirth} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="form-section">
          <legend>
            <span className="step">4</span> {t("form.membership")}
          </legend>
          <div className="grid-2">
            <Field
              name="admissionDate"
              label={t("form.admissionDate")}
              required
              error={err("admissionDate")}
              hint={t("form.admissionHint", { date: businessDateLabel })}
            >
              <input id="admissionDate" name="admissionDate" type="date" max={businessDate} defaultValue={initial.admissionDate} />
            </Field>
            <div className="field">
              <span className="label">{t("form.commLocale")}</span>
              <div className="segmented wide" role="radiogroup" aria-label={t("form.commLocale")}>
                {(["", "en", "bn"] as const).map((l) => (
                  <label key={l || "default"}>
                    <input type="radio" name="commLocale" value={l} defaultChecked={(initial.commLocale ?? "") === l} />
                    <span>{l ? t(`languages.${l}`) : t("form.somitiDefault")}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </fieldset>

        <div className="form-actions">
          <Link href="/members" className="btn ghost">
            {t("form.cancel")}
          </Link>
          <button className="btn primary" disabled={pending}>
            {pending ? (
              <>
                <span className="spinner" aria-hidden="true" /> {t("form.submitting")}
              </>
            ) : (
              t("form.submit")
            )}
          </button>
        </div>
      </form>

      <aside className="admit-preview" aria-label={t("form.preview")}>
        <span className="preview-label">{t("form.preview")}</span>
        <div className="id-card">
          <div className="id-card-band" style={{ "--h": memberHue(nextNo) } as React.CSSProperties}>
            <span>{t("form.nextNo")}</span>
            <strong>#{formatInteger(nextNo, locale)}</strong>
          </div>
          <MemberAvatar member={preview} locale={locale} size="lg" />
          <strong className={`id-name${preview.nameEn || preview.nameBn ? "" : " placeholder"}`}>
            {primaryName(preview, locale) || t("form.previewName")}
          </strong>
          {secondaryName(preview, locale) && <span className="id-name-alt">{secondaryName(preview, locale)}</span>}
          <dl className="id-facts">
            {(guardian.nameEn || guardian.nameBn) && (
              <div>
                <dt>{t(`profile.guardian.${v.guardianRelation === "husband" ? "husband" : "father"}`)}</dt>
                <dd>{primaryName(guardian, locale)}</dd>
              </div>
            )}
            {phone && (
              <div>
                <dt>{t("profile.phone")}</dt>
                <dd>{digits(formatBdPhone(phone))}</dd>
              </div>
            )}
            {filled.nid && (
              <div>
                <dt>{t("profile.nid")}</dt>
                <dd>•••• {digits(nidDigits.slice(-4))}</dd>
              </div>
            )}
            {v.commLocale && (
              <div>
                <dt>{t("profile.commLocale")}</dt>
                <dd>{t(`languages.${v.commLocale as "en" | "bn"}`)}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="completeness">
          <span className="ring-lg" style={{ "--p": pct / 100 } as React.CSSProperties}>
            <b>{formatInteger(pct, locale)}%</b>
          </span>
          <ul>
            {COMPLETENESS.map((k) => (
              <li key={k} className={filled[k] ? "ok" : undefined}>
                {k === "guardianName"
                  ? t("form.guardian")
                  : k === "nid"
                    ? t("form.nid")
                    : k === "dateOfBirth"
                      ? t("form.dob")
                      : t(`form.${k}`)}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
