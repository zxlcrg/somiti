"use client";

import { useEffect, useRef, useState } from "react";
import { toLatinDigits } from "@/lib/digits";

const LENGTH = 6;

/**
 * Six boxes for the sign-in code. Typing moves forward, Backspace moves back,
 * and pasting a whole code (Latin or Bangla digits) fills every box. The
 * joined value goes out in one hidden field; `onComplete` fires when all six
 * boxes are filled.
 */
export function OtpInput({
  name,
  label,
  digitLabel,
  invalid,
  disabled,
  onComplete,
}: {
  name: string;
  label: string;
  digitLabel: (n: number) => string;
  invalid?: boolean;
  disabled?: boolean;
  onComplete?: () => void;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(LENGTH).fill(""));
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const code = digits.join("");

  // After the render that filled the last box, so the hidden field already holds the code.
  useEffect(() => {
    if (code.length === LENGTH) onComplete?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  function update(next: string[], focus?: number) {
    setDigits(next);
    if (focus !== undefined) boxes.current[Math.min(focus, LENGTH - 1)]?.focus();
  }

  function fill(from: number, text: string) {
    const incoming = toLatinDigits(text).replace(/\D/g, "").slice(0, LENGTH - from).split("");
    if (incoming.length === 0) return;
    const next = [...digits];
    incoming.forEach((d, i) => (next[from + i] = d));
    update(next, from + incoming.length);
  }

  return (
    <fieldset className={`otp${invalid ? " is-invalid" : ""}`} disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <input type="hidden" name={name} value={code} />
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className={digit ? "filled" : undefined}
          value={digit}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={digitLabel(i + 1)}
          autoFocus={i === 0}
          maxLength={LENGTH}
          onChange={(e) => {
            if (/\d|[০-৯]/.test(e.target.value)) return fill(i, e.target.value);
            const next = [...digits];
            next[i] = "";
            update(next);
          }}
          onPaste={(e) => {
            e.preventDefault();
            fill(0, e.clipboardData.getData("text"));
          }}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !digit && i > 0) {
              e.preventDefault();
              const next = [...digits];
              next[i - 1] = "";
              update(next, i - 1);
            } else if (e.key === "ArrowLeft" && i > 0) {
              boxes.current[i - 1]?.focus();
            } else if (e.key === "ArrowRight" && i < LENGTH - 1) {
              boxes.current[i + 1]?.focus();
            }
          }}
        />
      ))}
    </fieldset>
  );
}
