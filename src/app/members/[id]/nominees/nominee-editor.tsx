"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { toBanglaDigits, toLatinDigits } from "@/lib/digits";
import { formatPercentBp } from "@/lib/format";
import { initial, primaryName } from "@/lib/names";
import { bpToPercentInput, equalShares, parseSharePercent } from "@/lib/shares";
import { nomineeHue } from "../../nominee-colors";
import { saveNomineesAction, type NomineesState } from "./actions";
import { blankRow, type EditorField, type EditorRow } from "./editor-rows";

const RELATIONS = ["spouse", "son", "daughter", "father", "mother", "brother", "sister", "other"] as const;
const MAX_ROWS = 10;
const ADULT_AGE = 18;

type Field = EditorField;

function isMinor(dateOfBirth: string, on: string): boolean {
  const d = toLatinDigits(dateOfBirth);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > on) return false;
  const [by, bm, bd] = d.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = on.split("-").map(Number) as [number, number, number];
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0) < ADULT_AGE;
}

export function NomineeEditor({
  memberId,
  initialRows,
  businessDate,
}: {
  memberId: string;
  initialRows: EditorRow[];
  businessDate: string;
}) {
  const t = useTranslations("members.nominees");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const [state, action, pending] = useActionState<NomineesState, FormData>(
    saveNomineesAction.bind(null, memberId),
    {},
  );
  const [rows, setRows] = useState<EditorRow[]>(initialRows);

  // Errors come back by row position; remember which rows were sent, so they
  // stay on the right row even if rows are later added or removed.
  const [sentKeys, setSentKeys] = useState<string[]>([]);
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setEdited(new Set());
  }
  const errorsByKey = new Map(
    Object.entries(state.rows ?? {}).map(([i, errs]) => [sentKeys[Number(i)], errs]),
  );
  const err = (row: EditorRow, field: Field) => {
    const code = errorsByKey.get(row.key)?.[field];
    return code && !edited.has(`${row.key}.${field}`) ? t(`errors.${code}`) : undefined;
  };

  const shares = rows.map((r) => parseSharePercent(r.share) ?? 0);
  const total = shares.reduce((a, b) => a + b, 0);
  const status = total === 10_000 ? "complete" : total > 10_000 ? "over" : "left";
  const pct = (bp: number) => formatPercentBp(bp, locale);
  const num = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);

  function update(key: string, field: Field, value: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
    // "Enter it in English or Bangla" errors sit on the English field; typing either script answers them.
    const partner: Partial<Record<Field, Field>> = { nameBn: "nameEn", minorGuardianNameBn: "minorGuardianNameEn" };
    setEdited((prev) => {
      const next = new Set(prev).add(`${key}.${field}`);
      if (partner[field]) next.add(`${key}.${partner[field]}`);
      return next;
    });
  }

  function splitEqually() {
    const split = equalShares(rows.length);
    setRows((prev) => prev.map((r, i) => ({ ...r, share: bpToPercentInput(split[i]!) })));
    setEdited((prev) => new Set([...prev, ...rows.map((r) => `${r.key}.share`)]));
  }

  function addRow() {
    const left = Math.max(0, 10_000 - total);
    setRows((prev) => [...prev, blankRow(left ? bpToPercentInput(left) : "")]);
  }

  const payload = JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      nameEn: r.nameEn,
      nameBn: r.nameBn,
      relation: r.relation,
      phone: r.phone,
      nid: r.nid,
      dateOfBirth: r.dateOfBirth,
      minorGuardianNameEn: r.minorGuardianNameEn,
      minorGuardianNameBn: r.minorGuardianNameBn,
      share: r.share,
    })),
  );

  const formError =
    state.form === "shares_total"
      ? t("errors.shares_total", { pct: pct(state.totalBp ?? 0) })
      : state.form === "forbidden"
        ? t("inactive")
        : state.form
          ? t(`errors.${state.form}`)
          : undefined;

  return (
    <form
      className="nominee-editor"
      noValidate
      onSubmit={(e) => {
        // Submitted by hand rather than through the form's action prop: React
        // resets a form after its action runs, which empties the controlled
        // dropdowns while the rest of the rows are still being fixed.
        e.preventDefault();
        setSentKeys(rows.map((r) => r.key));
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <input type="hidden" name="payload" value={payload} />

      <div className={`share-meter ${status}`} aria-live="polite">
        <div className="share-bar big" aria-hidden="true">
          {rows.map((r, i) =>
            shares[i]! > 0 ? (
              <span key={r.key} style={{ "--h": nomineeHue(i), flexGrow: shares[i] } as React.CSSProperties}>
                {shares[i]! >= 1000 ? pct(shares[i]!) : ""}
              </span>
            ) : null,
          )}
          {total < 10_000 && <span className="rest" style={{ flexGrow: 10_000 - total }} />}
        </div>
        <div className="share-meter-row">
          <strong>{t("editor.total", { pct: pct(total) })}</strong>
          <span className="share-status">
            {status === "complete"
              ? `✓ ${t("editor.complete")}`
              : status === "over"
                ? t("editor.over", { pct: pct(total - 10_000) })
                : t("editor.left", { pct: pct(10_000 - total) })}
          </span>
          {rows.length > 1 && (
            <button type="button" className="btn ghost small" onClick={splitEqually}>
              ⚖ {t("editor.splitEqually")}
            </button>
          )}
        </div>
      </div>

      {formError && (
        <p className="form-error" role="alert" key={state.attempt}>
          {formError}
        </p>
      )}

      {rows.length === 0 && <p className="nominees-empty muted">{t("editor.emptyEditor")}</p>}

      <ol className="nominee-rows">
        {rows.map((row, i) => {
          const minor = isMinor(row.dateOfBirth, businessDate);
          const name = primaryName({ nameEn: row.nameEn.trim() || null, nameBn: row.nameBn.trim() || null }, locale);
          const id = (field: string) => `${row.key}-${field}`;
          const field = (f: Field, label: string, input: React.ReactNode, hint?: string) => {
            const e = err(row, f);
            return (
              <div className={`field${e ? " has-error" : ""}`}>
                <label htmlFor={id(f)}>{label}</label>
                {input}
                {e ? <small className="field-error">{e}</small> : hint && <small>{hint}</small>}
              </div>
            );
          };
          const text = (f: Field, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
            <input
              id={id(f)}
              value={row[f]}
              onChange={(e) => update(row.key, f, e.target.value)}
              autoComplete="off"
              {...extra}
            />
          );
          return (
            <li key={row.key} className="nominee-row" style={{ "--h": nomineeHue(i) } as React.CSSProperties}>
              <header>
                <span className="nominee-dot" aria-hidden="true">
                  {name ? initial({ nameEn: row.nameEn || null, nameBn: row.nameBn || null }, locale) : num(String(i + 1))}
                </span>
                <strong>{name || t("editor.nominee", { n: i + 1 })}</strong>
                {minor && <span className="chip minor">{t("minor")}</span>}
                <button
                  type="button"
                  className="link danger"
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                >
                  {t("editor.remove")}
                </button>
              </header>

              <div className="grid-2">
                {field("nameEn", t("editor.nameEn"), text("nameEn", { lang: "en", autoFocus: !row.id && i === rows.length - 1 && rows.length > 1 }))}
                {field("nameBn", t("editor.nameBn"), text("nameBn", { lang: "bn" }))}
                {field(
                  "relation",
                  t("editor.relation"),
                  <select id={id("relation")} value={row.relation} onChange={(e) => update(row.key, "relation", e.target.value)}>
                    <option value="">{t("editor.choose")}</option>
                    {RELATIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`relations.${r}`)}
                      </option>
                    ))}
                  </select>,
                )}
                <div className={`field share-field${err(row, "share") ? " has-error" : ""}`}>
                  <label htmlFor={id("share")}>{t("editor.share")}</label>
                  <div className="share-inputs">
                    <input
                      type="range"
                      className="slider"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round((shares[i] ?? 0) / 100)}
                      onChange={(e) => update(row.key, "share", e.target.value)}
                      style={{ "--fill": `${(shares[i] ?? 0) / 100}%` } as React.CSSProperties}
                      aria-label={t("editor.share")}
                    />
                    <div className="pct-input">
                      {text("share", { inputMode: "decimal", placeholder: "0" })}
                      <span>%</span>
                    </div>
                  </div>
                  {err(row, "share") && <small className="field-error">{err(row, "share")}</small>}
                </div>
                {field("phone", t("editor.phone"), text("phone", { type: "tel", inputMode: "tel", placeholder: "017XX-XXXXXX" }))}
                {field(
                  "nid",
                  t("editor.nid"),
                  text("nid", { inputMode: "numeric" }),
                  row.nidLast4 ? t("editor.nidOnFile", { last4: num(row.nidLast4) }) : undefined,
                )}
                {field("dateOfBirth", t("editor.dob"), text("dateOfBirth", { type: "date", max: businessDate }))}
              </div>

              {minor && (
                <div className="minor-box">
                  <p>{t("editor.minorNote")}</p>
                  <div className="grid-2">
                    {field("minorGuardianNameEn", t("editor.guardianEn"), text("minorGuardianNameEn", { lang: "en" }))}
                    {field("minorGuardianNameBn", t("editor.guardianBn"), text("minorGuardianNameBn", { lang: "bn" }))}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {rows.length < MAX_ROWS && (
        <button type="button" className="add-row" onClick={addRow}>
          ＋ {t("editor.addRow")}
        </button>
      )}

      <div className="form-actions">
        <Link href={`/members/${memberId}`} className="btn ghost">
          {t("editor.cancel")}
        </Link>
        <button className="btn primary" disabled={pending}>
          {pending ? (
            <>
              <span className="spinner" aria-hidden="true" /> {t("editor.saving")}
            </>
          ) : rows.length === 0 && initialRows.length > 0 ? (
            t("editor.clearAll")
          ) : (
            t("editor.save")
          )}
        </button>
      </div>
    </form>
  );
}
