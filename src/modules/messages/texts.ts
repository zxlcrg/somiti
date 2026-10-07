import type { Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatAmount } from "@/lib/format";

/*
 * Member SMS wording. Kept short: Bangla goes out as Unicode, where one
 * message holds 70 characters, and English avoids "৳" so it stays in the
 * cheaper 160-character alphabet.
 */

/** "1,500" for whole taka, "1,500.50" otherwise. */
function amount(paisa: bigint, locale: Locale): string {
  return formatAmount(paisa, locale).replace(/[.।]([0০]{2})$/, "");
}

export interface MovementText {
  somiti: string;
  productCode: string;
  accountNo: number;
  entryNo: bigint;
  amount: bigint;
  balance: bigint;
  fine?: bigint | null;
}

export function depositText(m: MovementText, locale: Locale): string {
  const fine = m.fine && m.fine > 0n ? m.fine : null;
  if (locale === "bn") {
    const n = (v: bigint | number) => toBanglaDigits(String(v));
    return (
      `${m.somiti}: ${m.productCode} হিসাব ${n(m.accountNo)}-এ ৳${amount(m.amount, "bn")} জমা, রসিদ ${n(m.entryNo)}।` +
      (fine ? ` জরিমানা ৳${amount(fine, "bn")}।` : "") +
      ` ব্যালান্স ৳${amount(m.balance, "bn")}।`
    );
  }
  return (
    `${m.somiti}: Tk ${amount(m.amount, "en")} deposited to ${m.productCode} a/c ${m.accountNo}, receipt ${m.entryNo}.` +
    (fine ? ` Late fine Tk ${amount(fine, "en")}.` : "") +
    ` Balance Tk ${amount(m.balance, "en")}.`
  );
}

export function withdrawalText(m: MovementText, locale: Locale): string {
  if (locale === "bn") {
    const n = (v: bigint | number) => toBanglaDigits(String(v));
    return `${m.somiti}: ${m.productCode} হিসাব ${n(m.accountNo)} থেকে ৳${amount(m.amount, "bn")} উত্তোলন, পেমেন্ট ${n(m.entryNo)}। ব্যালান্স ৳${amount(m.balance, "bn")}।`;
  }
  return `${m.somiti}: Tk ${amount(m.amount, "en")} withdrawn from ${m.productCode} a/c ${m.accountNo}, payment ${m.entryNo}. Balance Tk ${amount(m.balance, "en")}.`;
}
