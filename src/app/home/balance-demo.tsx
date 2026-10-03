"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { PAISA_PER_TAKA } from "@/lib/money";

const MAX_TAKA = 50_000;

/** A deposit posted both ways: the debit and credit bars always move together. */
export function BalanceDemo() {
  const t = useTranslations("home.balance");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const sliderId = useId();
  const [taka, setTaka] = useState(12_500);
  const amount = formatTaka(BigInt(taka) * PAISA_PER_TAKA, locale);
  const width = `${Math.max(4, (taka / MAX_TAKA) * 100)}%`;

  return (
    <div className="panel">
      <h2 className="panel-title">{t("title")}</h2>
      <p className="hint">{t("lead")}</p>
      <label htmlFor={sliderId} className="slider-label">
        <span>{t("deposit")}</span>
        <strong>{amount}</strong>
      </label>
      <input
        id={sliderId}
        className="slider"
        type="range"
        min={500}
        max={MAX_TAKA}
        step={500}
        value={taka}
        onChange={(e) => setTaka(Number(e.target.value))}
        style={{ "--fill": `${(taka / MAX_TAKA) * 100}%` } as React.CSSProperties}
      />
      <div className="bars">
        {(["debit", "credit"] as const).map((side) => (
          <div key={side}>
            <div className="bar-head">
              <span>{t(side)}</span>
              <strong>{amount}</strong>
            </div>
            <div className="bar">
              <div className={`bar-fill ${side}`} style={{ width }} />
            </div>
          </div>
        ))}
      </div>
      <p className="balanced" key={taka}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 10.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {t("balanced")}
      </p>
    </div>
  );
}
