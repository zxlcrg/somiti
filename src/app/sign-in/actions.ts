"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb } from "@/db/client";
import { LOCALE_COOKIE } from "@/i18n/config";
import { formatBdPhone, normalizeBdPhone } from "@/lib/phone";
import {
  getSmsSender,
  requestSignInCode,
  revokeSession,
  verifySignInCode,
  type SmsSender,
} from "@/modules/auth";
import { LAST_SLUG_COOKIE, SESSION_COOKIE } from "../auth";

export type SignInError =
  | "missing"
  | "invalid_phone"
  | "unknown_somiti"
  | "too_many"
  | "invalid_code"
  | "expired"
  | "locked"
  | "server";

export interface SignInState {
  step: "phone" | "code";
  slug: string;
  phone: string;
  error?: SignInError;
  attemptsLeft?: number;
  /** Seconds until "resend" unlocks, counted from sentAt. */
  resendIn?: number;
  /** Changes on every send, so the page restarts its countdown. */
  sentAt?: number;
  /** Development only: the SMS that would have been sent, for the browser console. */
  devSms?: { to: string; text: string };
}

/** Never true in a production build, so a code can't reach the browser there. */
const SHOW_CODE_IN_BROWSER = process.env.NODE_ENV === "development";

const YEAR = 60 * 60 * 24 * 365;

async function device(): Promise<string | undefined> {
  return (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
}

export async function signInAction(prev: SignInState, form: FormData): Promise<SignInState> {
  const intent = String(form.get("intent") ?? "");
  const slug = String(form.get("slug") ?? prev.slug).trim().toLowerCase();
  const phoneInput = String(form.get("phone") ?? prev.phone);

  if (intent === "change") return { step: "phone", slug, phone: phoneInput };

  if (intent === "request" || intent === "resend") {
    if (!slug || !phoneInput.trim()) return { ...prev, step: "phone", slug, phone: phoneInput, error: "missing" };
    try {
      const sender = getSmsSender();
      let devSms: SignInState["devSms"];
      const sms: SmsSender = SHOW_CODE_IN_BROWSER
        ? {
            async send(to, text) {
              await sender.send(to, text);
              devSms = { to, text };
            },
          }
        : sender;
      const result = await requestSignInCode(getAppDb(), { slug, phone: phoneInput, sms });
      if (result.status === "invalid_phone" || result.status === "unknown_somiti") {
        return { step: "phone", slug, phone: phoneInput, error: result.status };
      }
      (await cookies()).set(LAST_SLUG_COOKIE, slug, { path: "/", maxAge: YEAR, sameSite: "lax", httpOnly: true });
      const phone = formatBdPhone(normalizeBdPhone(phoneInput)!);
      if (result.status === "too_many") {
        return { step: intent === "resend" ? "code" : "phone", slug, phone, error: "too_many" };
      }
      return { step: "code", slug, phone, resendIn: result.resendInSeconds, sentAt: Date.now(), devSms };
    } catch (err) {
      console.error(err);
      return { ...prev, slug, phone: phoneInput, error: "server" };
    }
  }

  if (intent === "verify") {
    const code = String(form.get("code") ?? "");
    let result;
    try {
      result = await verifySignInCode(getAppDb(), { slug, phone: phoneInput, code, device: await device() });
    } catch (err) {
      console.error(err);
      return { ...prev, error: "server" };
    }
    if (!result.ok) {
      return {
        ...prev,
        error: result.reason === "invalid" ? "invalid_code" : result.reason,
        attemptsLeft: result.reason === "invalid" ? result.attemptsLeft : undefined,
      };
    }
    const store = await cookies();
    store.set(SESSION_COOKIE, result.cookie, {
      path: "/",
      expires: result.expiresAt,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    if (result.locale) store.set(LOCALE_COOKIE, result.locale, { path: "/", maxAge: YEAR, sameSite: "lax" });
    redirect("/dashboard");
  }

  return prev;
}

export async function signOutAction(): Promise<void> {
  const store = await cookies();
  await revokeSession(getAppDb(), store.get(SESSION_COOKIE)?.value, await device());
  store.delete(SESSION_COOKIE);
  redirect("/sign-in");
}
