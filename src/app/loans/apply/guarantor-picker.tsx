"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { toLatinDigits } from "@/lib/digits";
import { formatInteger } from "@/lib/format";
import { primaryName } from "@/lib/names";
import type { GuarantorCandidate } from "@/modules/loans/guarantors";
import { MemberAvatar } from "../../members/member-avatar";

export type Candidate = GuarantorCandidate;

const SHOWN = 6;
const MAX = 3;

/** Pick up to three members to stand guarantor; the chosen ones go up as guarantorIds. */
export function GuarantorPicker({
  candidates,
  required,
  locale,
  error,
  onChange,
}: {
  candidates: Candidate[];
  required: number;
  locale: Locale;
  error?: string;
  onChange: () => void;
}) {
  const t = useTranslations("loans.guarantors");
  const [chosen, setChosen] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const num = (n: number) => formatInteger(n, locale);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const query = toLatinDigits(q.trim()).toLowerCase();
  const digits = query.replace(/[\s+-]/g, "");
  const matches = query
    ? candidates.filter(
        (c) =>
          !chosen.includes(c.id) &&
          ((c.nameEn ?? "").toLowerCase().includes(query) ||
            (c.nameBn ?? "").includes(q.trim()) ||
            String(c.memberNo) === digits ||
            (digits.length >= 4 && /^\d+$/.test(digits) && c.phone.replace(/\D/g, "").includes(digits))),
      )
    : [];
  const full = chosen.length >= MAX;
  const set = (next: string[]) => {
    setChosen(next);
    onChange();
  };

  return (
    <section className={`loan-card guarantor-card${error ? " has-error" : ""}`}>
      <div className="guarantor-head">
        <h2>
          <span aria-hidden="true">🤝</span> {t("title")}
        </h2>
        <span className={`count-pill${chosen.length >= required ? " ok" : ""}`}>
          {chosen.length > required ? t("named", { n: num(chosen.length) }) : required > 0 ? t("countOf", { n: num(chosen.length), of: num(required) }) : t("optional")}
        </span>
      </div>
      <p className="muted">{required > 0 ? t("needed", { count: required, n: num(required) }) : t("none")}</p>

      {chosen.length > 0 && (
        <ol className="guarantor-list">
          {chosen.map((id, i) => {
            const c = byId.get(id)!;
            return (
              <li key={id}>
                <input type="hidden" name="guarantorIds" value={id} />
                <span className="g-pos">{num(i + 1)}</span>
                <MemberAvatar member={c} locale={locale} />
                <span className="g-who">
                  <strong>{primaryName(c, locale)}</strong>
                  <small className="muted">
                    {t("memberNo", { no: num(c.memberNo) })}
                    {c.guarantees > 0 && <> · {t("already", { count: c.guarantees, n: num(c.guarantees) })}</>}
                  </small>
                </span>
                <button type="button" className="g-remove" aria-label={t("remove", { name: primaryName(c, locale) })} onClick={() => set(chosen.filter((x) => x !== id))}>
                  ✕
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {!full && (
        <div className="field guarantor-search">
          <label htmlFor="guarantor-q">{t("search")}</label>
          <input
            id="guarantor-q"
            type="search"
            autoComplete="off"
            value={q}
            onChange={(ev) => setQ(ev.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-describedby="guarantor-hint"
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                if (matches[0]) {
                  set([...chosen, matches[0].id]);
                  setQ("");
                }
              }
            }}
          />
          {query && (
            <ul className="guarantor-matches" role="listbox" aria-label={t("search")}>
              {matches.slice(0, SHOWN).map((c) => (
                <li key={c.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => {
                      set([...chosen, c.id]);
                      setQ("");
                    }}
                  >
                    <MemberAvatar member={c} locale={locale} />
                    <span className="g-who">
                      <strong>{primaryName(c, locale)}</strong>
                      <small className="muted">
                        {t("memberNo", { no: num(c.memberNo) })}
                        {c.guarantees > 0 && <> · {t("already", { count: c.guarantees, n: num(c.guarantees) })}</>}
                      </small>
                    </span>
                    <span className="g-add" aria-hidden="true">
                      ＋
                    </span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="muted g-empty">{t("noMatch")}</li>}
            </ul>
          )}
          {!error && <small id="guarantor-hint">{t("hint")}</small>}
        </div>
      )}
      {error && <small className="field-error">{error}</small>}
    </section>
  );
}
