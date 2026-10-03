import type { Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";

/** Sends one text message. The real gateway arrives with M2; until then codes go to the server log. */
export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

/** Prints messages to the server terminal. For development and tests only. */
export const consoleSms: SmsSender = {
  async send(to, text) {
    console.log(`[sms] to ${to}: ${text}`);
  },
};

/** The sender the app uses. Refuses to run in production until a gateway is configured. */
export function getSmsSender(): SmsSender {
  if (process.env.NODE_ENV === "production" && process.env.SMS_CONSOLE !== "1") {
    throw new Error("No SMS gateway is configured. Set SMS_CONSOLE=1 to log codes instead (not for real use).");
  }
  return consoleSms;
}

export function signInCodeText(code: string, minutes: number, locale: Locale): string {
  return locale === "bn"
    ? `আপনার সমিতি লগইন কোড ${toBanglaDigits(code)}। ${toBanglaDigits(String(minutes))} মিনিটের মধ্যে ব্যবহার করুন। কাউকে জানাবেন না।`
    : `Your Somiti sign-in code is ${code}. It expires in ${minutes} minutes. Never share it.`;
}
