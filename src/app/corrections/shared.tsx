import type { CorrectionKind } from "@/modules/corrections";

export const KIND_ICON: Record<CorrectionKind, string> = {
  savings_deposit: "💰",
  savings_withdrawal: "🏧",
  share_purchase: "📜",
  loan_repayment: "🤝",
};

/** Where the corrected transaction lives, so the officer can record the right one there. */
export function placeHref(t: { savingsAccountId: string | null; loanId: string | null; member: { id: string } }): string {
  if (t.savingsAccountId) return `/savings/accounts/${t.savingsAccountId}`;
  if (t.loanId) return `/loans/${t.loanId}`;
  return `/members/${t.member.id}`;
}
