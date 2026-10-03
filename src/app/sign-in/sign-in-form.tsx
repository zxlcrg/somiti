"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toBanglaDigits } from "@/lib/digits";
import { signInAction, type SignInState } from "./actions";
import { OtpInput } from "./otp-input";

function useCountdown(seconds: number | undefined, startedAt: number | undefined): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    if (!seconds || !startedAt) return;
    const tick = () => setLeft(Math.max(0, seconds - Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [seconds, startedAt]);
  return left;
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function SignInForm({ initialSlug, devHint }: { initialSlug: string; devHint: boolean }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, {
    step: "phone",
    slug: initialSlug,
    phone: "",
  });
  const formRef = useRef<HTMLFormElement>(null);
  const verifyRef = useRef<HTMLButtonElement>(null);
  const resendLeft = useCountdown(state.resendIn, state.sentAt);

  const error = state.error ? (
    <p className="form-error" role="alert" key={`${state.error}-${state.attemptsLeft}`}>
      {t(`errors.${state.error}`)}
      {state.attemptsLeft !== undefined && <> {t("errors.attemptsLeft", { count: state.attemptsLeft })}</>}
    </p>
  ) : null;

  if (state.step === "phone") {
    return (
      <form action={action} className="auth-step" key="phone">
        <input type="hidden" name="intent" value="request" />
        <div className="field">
          <label htmlFor="slug">{t("slugLabel")}</label>
          <input
            id="slug"
            name="slug"
            defaultValue={state.slug}
            placeholder={t("slugPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="organization"
            required
            autoFocus={!state.slug}
            aria-invalid={state.error === "unknown_somiti"}
          />
          <small>{t("slugHint")}</small>
        </div>
        <div className="field">
          <label htmlFor="phone">{t("phoneLabel")}</label>
          <div className={`phone-input${state.error === "invalid_phone" ? " is-invalid" : ""}`}>
            <span aria-hidden="true">+88</span>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              defaultValue={state.phone}
              placeholder={t("phonePlaceholder")}
              required
              autoFocus={!!state.slug}
              aria-invalid={state.error === "invalid_phone"}
            />
          </div>
        </div>
        {error}
        <button className="btn primary block" disabled={pending}>
          {pending ? (
            <>
              <Spinner /> {t("sending")}
            </>
          ) : (
            t("sendCode")
          )}
        </button>
      </form>
    );
  }

  const codeError = state.error === "invalid_code" || state.error === "locked" || state.error === "expired";
  return (
    <form action={action} ref={formRef} className="auth-step" key={`code-${state.sentAt}`}>
      <input type="hidden" name="slug" value={state.slug} />
      <input type="hidden" name="phone" value={state.phone} />
      <h2 className="step-title">{t("codeTitle")}</h2>
      <p className="muted">
        {t("codeSentTo", { phone: locale === "bn" ? toBanglaDigits(state.phone) : state.phone })}{" "}
        <button className="link" name="intent" value="change" formNoValidate>
          {t("changeNumber")}
        </button>
      </p>
      <OtpInput
        key={`${state.sentAt}-${state.attemptsLeft}-${state.error}`}
        name="code"
        label={t("codeLabel")}
        digitLabel={(n) => t("digit", { n })}
        invalid={codeError}
        disabled={pending}
        onComplete={() => {
          if (state.error !== "locked" && state.error !== "expired") formRef.current?.requestSubmit(verifyRef.current);
        }}
      />
      {error}
      <button ref={verifyRef} className="btn primary block" name="intent" value="verify" disabled={pending}>
        {pending ? (
          <>
            <Spinner /> {t("verifying")}
          </>
        ) : (
          t("verify")
        )}
      </button>
      <div className="resend">
        {resendLeft > 0 ? (
          <span className="muted">
            <span className="ring" style={{ "--p": resendLeft / (state.resendIn || 60) } as React.CSSProperties} />
            {t("resendIn", { seconds: resendLeft })}
          </span>
        ) : (
          <button className="link" name="intent" value="resend" formNoValidate disabled={pending}>
            {t("resend")}
          </button>
        )}
      </div>
      {devHint && <p className="dev-hint">{t("devHint")}</p>}
    </form>
  );
}
