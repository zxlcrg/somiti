"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { formatInteger, formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";

/** Live preview of how a typed amount is parsed and shown in both languages. */
export function AmountPlayground() {
  const t = useTranslations("home.playground");
  const inputId = useId();
  const [input, setInput] = useState("1,23,45,678.50");
  const paisa = parseTaka(input);
  const invalid = input.trim() !== "" && paisa === null;

  return (
    <div className="panel" id="try">
      <h2 className="panel-title">{t("title")}</h2>
      <label htmlFor={inputId} className="hint">
        {t("hint")}
      </label>
      <div className={`amount-input${invalid ? " is-invalid" : ""}`}>
        <span aria-hidden="true">৳</span>
        <input
          id={inputId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("placeholder")}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={invalid}
        />
      </div>
      {invalid ? (
        <p className="error" role="alert">
          {t("invalid")}
        </p>
      ) : (
        <div className="outputs" aria-live="polite">
          <div className="output" key={`en-${paisa}`}>
            <span className="output-label">{t("english")}</span>
            <strong lang="en">{paisa === null ? "—" : formatTaka(paisa, "en")}</strong>
          </div>
          <div className="output" key={`bn-${paisa}`}>
            <span className="output-label">{t("bangla")}</span>
            <strong lang="bn">{paisa === null ? "—" : formatTaka(paisa, "bn")}</strong>
          </div>
          {paisa !== null && <p className="footnote">{t("paisa", { count: formatInteger(paisa, "en") })}</p>}
        </div>
      )}
    </div>
  );
}
