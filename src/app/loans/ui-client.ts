import type { LoanStatus } from "@/modules/loans/loans";

export const STATUS_ICON: Record<LoanStatus, string> = {
  applied: "📝",
  approved: "✅",
  rejected: "⛔",
  cancelled: "↩️",
  disbursed: "💸",
  closed: "🏁",
  written_off: "🗂️",
};

export const METHOD_ICON = { cash: "💵", bank: "🏦", mobile_wallet: "📱" } as const;
