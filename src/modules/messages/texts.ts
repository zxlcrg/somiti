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

export interface LoanRepaymentText {
  somiti: string;
  productCode: string;
  loanNo: number;
  entryNo: bigint;
  amount: bigint;
  stillOwed: bigint;
  fine?: bigint;
  /** Charge let off for settling early. */
  rebate?: bigint;
}

export function loanRepaymentText(m: LoanRepaymentText, locale: Locale): string {
  if (locale === "bn") {
    const n = (v: bigint | number) => toBanglaDigits(String(v));
    return (
      `${m.somiti}: ${m.productCode} ঋণ ${n(m.loanNo)}-এ ৳${amount(m.amount, "bn")} কিস্তি জমা, রসিদ ${n(m.entryNo)}।` +
      (m.fine ? ` জরিমানা ৳${amount(m.fine, "bn")}।` : "") +
      (m.rebate ? ` আগাম পরিশোধে ছাড় ৳${amount(m.rebate, "bn")}।` : "") +
      (m.stillOwed > 0n ? ` বাকি ৳${amount(m.stillOwed, "bn")}।` : " ঋণ সম্পূর্ণ পরিশোধ হয়েছে।")
    );
  }
  return (
    `${m.somiti}: Tk ${amount(m.amount, "en")} paid on ${m.productCode} loan ${m.loanNo}, receipt ${m.entryNo}.` +
      (m.fine ? ` Late fine Tk ${amount(m.fine, "en")}.` : "") +
      (m.rebate ? ` Early settlement rebate Tk ${amount(m.rebate, "en")}.` : "") +
    (m.stillOwed > 0n ? ` Still owed Tk ${amount(m.stillOwed, "en")}.` : " Loan fully repaid.")
  );
}

export interface LoanRescheduleText {
  somiti: string;
  productCode: string;
  loanNo: number;
  installments: number;
  /** The usual new installment (the last may be smaller). */
  installment: bigint;
  firstDueOn: string;
}

export function loanRescheduleText(m: LoanRescheduleText, locale: Locale): string {
  const [y, mo, d] = m.firstDueOn.split("-");
  if (locale === "bn") {
    const n = (v: bigint | number | string) => toBanglaDigits(String(v));
    return `${m.somiti}: ${m.productCode} ঋণ ${n(m.loanNo)} নতুন সূচি: ${n(m.installments)} কিস্তি, প্রতিটি ৳${amount(m.installment, "bn")}, প্রথমটি ${n(`${d}/${mo}/${y}`)}।`;
  }
  return `${m.somiti}: ${m.productCode} loan ${m.loanNo} rescheduled: ${m.installments} installments of Tk ${amount(m.installment, "en")}, first due ${d}/${mo}/${y}.`;
}
