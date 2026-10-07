/**
 * Starting chart of accounts for a new somiti, covering the posting rules
 * in the architecture doc and the review's additions. A somiti can add its
 * own accounts; `systemKey` marks the ones posting rules rely on.
 *
 * DRAFT: the codes, the list and especially the Bangla names must be
 * checked with a cooperative accountant and the somiti's own books in M0.
 */
export interface ChartAccount {
  code: string;
  nameEn: string;
  nameBn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  systemKey?: string;
  /** Header accounts group others and take no postings. */
  header?: boolean;
  parent?: string;
}

export const DEFAULT_CHART: readonly ChartAccount[] = [
  { code: "1000", nameEn: "Assets", nameBn: "সম্পদ", type: "asset", header: true },
  { code: "1100", nameEn: "Cash in hand", nameBn: "হাতে নগদ", type: "asset", parent: "1000", systemKey: "cash_in_hand" },
  { code: "1110", nameEn: "Cash with collectors", nameBn: "মাঠকর্মীর হাতে নগদ", type: "asset", parent: "1000", systemKey: "cash_with_collector" },
  { code: "1200", nameEn: "Bank", nameBn: "ব্যাংক", type: "asset", parent: "1000", systemKey: "bank" },
  { code: "1210", nameEn: "Mobile wallet", nameBn: "মোবাইল ওয়ালেট", type: "asset", parent: "1000", systemKey: "mobile_wallet" },
  { code: "1300", nameEn: "Loans receivable", nameBn: "ঋণ পাওনা", type: "asset", parent: "1000", systemKey: "loans_receivable" },

  { code: "2000", nameEn: "Liabilities", nameBn: "দায়", type: "liability", header: true },
  { code: "2100", nameEn: "Member savings", nameBn: "সদস্য সঞ্চয়", type: "liability", parent: "2000", systemKey: "member_savings" },
  { code: "2200", nameEn: "Dividend payable", nameBn: "প্রদেয় লভ্যাংশ", type: "liability", parent: "2000", systemKey: "dividend_payable" },
  { code: "2300", nameEn: "Advance received", nameBn: "অগ্রিম প্রাপ্তি", type: "liability", parent: "2000", systemKey: "advance_received" },

  { code: "3000", nameEn: "Equity", nameBn: "মূলধন", type: "equity", header: true },
  { code: "3100", nameEn: "Share capital", nameBn: "শেয়ার মূলধন", type: "equity", parent: "3000", systemKey: "share_capital" },
  { code: "3200", nameEn: "Reserve fund", nameBn: "সংরক্ষিত তহবিল", type: "equity", parent: "3000", systemKey: "reserve_fund" },
  { code: "3300", nameEn: "Current-year surplus", nameBn: "চলতি বছরের উদ্বৃত্ত", type: "equity", parent: "3000", systemKey: "current_year_surplus" },
  { code: "3900", nameEn: "Opening balance equity", nameBn: "প্রারম্ভিক ব্যালান্স সমন্বয়", type: "equity", parent: "3000", systemKey: "opening_balance_equity" },

  { code: "4000", nameEn: "Income", nameBn: "আয়", type: "income", header: true },
  { code: "4100", nameEn: "Service charge / interest income", nameBn: "সার্ভিস চার্জ / সুদ আয়", type: "income", parent: "4000", systemKey: "interest_income" },
  { code: "4200", nameEn: "Fine income", nameBn: "জরিমানা আয়", type: "income", parent: "4000", systemKey: "fine_income" },
  { code: "4300", nameEn: "Fee income", nameBn: "ফি আয়", type: "income", parent: "4000", systemKey: "fee_income" },
  { code: "4400", nameEn: "Bank interest income", nameBn: "ব্যাংক সুদ আয়", type: "income", parent: "4000", systemKey: "bank_interest_income" },

  { code: "5000", nameEn: "Expenses", nameBn: "ব্যয়", type: "expense", header: true },
  { code: "5100", nameEn: "Office rent", nameBn: "অফিস ভাড়া", type: "expense", parent: "5000" },
  { code: "5200", nameEn: "Salaries", nameBn: "বেতন-ভাতা", type: "expense", parent: "5000" },
  { code: "5300", nameEn: "SMS charges", nameBn: "এসএমএস খরচ", type: "expense", parent: "5000", systemKey: "sms_expense" },
  { code: "5400", nameEn: "Bank charges", nameBn: "ব্যাংক চার্জ", type: "expense", parent: "5000", systemKey: "bank_charges" },
  { code: "5500", nameEn: "Cash over / short", nameBn: "নগদ উদ্বৃত্ত / ঘাটতি", type: "expense", parent: "5000", systemKey: "cash_over_short" },
  { code: "5600", nameEn: "Profit on savings", nameBn: "সঞ্চয়ের উপর মুনাফা", type: "expense", parent: "5000", systemKey: "savings_profit_expense" },
];
