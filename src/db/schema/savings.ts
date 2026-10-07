import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { journalEntry, voucherStatusEnum } from "./ledger";
import { member } from "./members";
import { paymentMethodEnum } from "./shares";
import { appUser, tenant } from "./tenancy";

/** How often a product expects a deposit; "flexible" has no schedule. */
export const savingsFrequencyEnum = pgEnum("savings_frequency", ["flexible", "daily", "weekly", "monthly"]);
export const savingsAccountStatusEnum = pgEnum("savings_account_status", ["active", "closed"]);
export const savingsTxnKindEnum = pgEnum("savings_txn_kind", ["deposit", "withdrawal"]);
/** Where deposited money first lands: as paid at the office, or in a field collector's hands. */
export const depositChannelEnum = pgEnum("deposit_channel", ["office", "collector"]);

/**
 * A savings product is configuration, not code (architecture doc, "Products
 * as rows"): daily, weekly, monthly or flexible, with the expected
 * installment. Products are never deleted, only switched off.
 */
export const savingsProduct = pgTable(
  "savings_product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameBn: text("name_bn"),
    frequency: savingsFrequencyEnum("frequency").notNull(),
    /** Expected amount per period, in paisa; null for flexible products. */
    installment: bigint("installment", { mode: "bigint" }),
    /** Lowest deposit accepted at once, in paisa. */
    minDeposit: bigint("min_deposit", { mode: "bigint" }).notNull().default(sql`100`),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("savings_product_tenant_id").on(t.tenantId, t.id),
    unique("savings_product_code").on(t.tenantId, t.code),
    foreignKey({
      name: "savings_product_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    check("savings_product_code_format", sql`${t.code} ~ '^[A-Z0-9-]{1,12}$'`),
    check("savings_product_name", sql`length(trim(${t.nameEn})) BETWEEN 1 AND 80`),
    check(
      "savings_product_installment",
      sql`(${t.frequency} = 'flexible' AND ${t.installment} IS NULL) OR (${t.frequency} <> 'flexible' AND ${t.installment} > 0)`,
    ),
    check("savings_product_min_deposit", sql`${t.minDeposit} > 0`),
  ],
);

/**
 * A member's account in one product. The balance lives in the ledger
 * (Member savings, on the member's line); deposits are listed in
 * savings_transaction. One open account per member per product.
 */
export const savingsAccount = pgTable(
  "savings_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    /** Gap-free per somiti, printed on passbooks. */
    accountNo: integer("account_no").notNull(),
    memberId: uuid("member_id").notNull(),
    productId: uuid("product_id").notNull(),
    /** Agreed per-period amount, copied from the product when opened. */
    installment: bigint("installment", { mode: "bigint" }),
    openedOn: date("opened_on", { mode: "string" }).notNull(),
    status: savingsAccountStatusEnum("status").notNull().default("active"),
    openedBy: uuid("opened_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("savings_account_tenant_id").on(t.tenantId, t.id),
    unique("savings_account_no").on(t.tenantId, t.accountNo),
    uniqueIndex("savings_account_one_open")
      .on(t.tenantId, t.memberId, t.productId)
      .where(sql`${t.status} = 'active'`),
    foreignKey({
      name: "savings_account_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    foreignKey({
      name: "savings_account_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [savingsProduct.tenantId, savingsProduct.id],
    }),
    foreignKey({
      name: "savings_account_opened_by_fk",
      columns: [t.tenantId, t.openedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    index("savings_account_member").on(t.tenantId, t.memberId),
    check("savings_account_no_positive", sql`${t.accountNo} > 0`),
    check("savings_account_installment", sql`${t.installment} IS NULL OR ${t.installment} > 0`),
  ],
);

/**
 * Money in (deposits) and out (approved withdrawals). Each row is one
 * journal entry; a reversed entry stops counting. Append-only.
 */
export const savingsTransaction = pgTable(
  "savings_transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    accountId: uuid("account_id").notNull(),
    kind: savingsTxnKindEnum("kind").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    channel: depositChannelEnum("channel").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    /** Bank slip or bKash/Nagad transaction ID. */
    paymentRef: text("payment_ref"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("savings_transaction_entry").on(t.tenantId, t.journalEntryId),
    foreignKey({
      name: "savings_transaction_account_fk",
      columns: [t.tenantId, t.accountId],
      foreignColumns: [savingsAccount.tenantId, savingsAccount.id],
    }),
    foreignKey({
      name: "savings_transaction_entry_fk",
      columns: [t.tenantId, t.journalEntryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    foreignKey({
      name: "savings_transaction_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    index("savings_transaction_account").on(t.tenantId, t.accountId, t.createdAt),
    index("savings_transaction_date").on(t.tenantId, t.businessDate),
    check("savings_transaction_amount", sql`${t.amount} > 0`),
    check(
      "savings_transaction_wallet_ref",
      sql`${t.paymentMethod} <> 'mobile_wallet' OR length(trim(${t.paymentRef})) > 0`,
    ),
    // A field collector takes cash; bank and wallet payments reach the somiti directly.
    check("savings_transaction_collector_cash", sql`${t.channel} = 'office' OR ${t.paymentMethod} = 'cash'`),
  ],
);

/**
 * A withdrawal waiting for a second officer (maker-checker, like a manual
 * voucher). Nothing is paid or posted until a different user approves it;
 * approval posts Dr Member savings, Cr cash, bank or wallet and records the
 * entry here and as a savings_transaction. A decision is final.
 */
export const savingsWithdrawal = pgTable(
  "savings_withdrawal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    accountId: uuid("account_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    /** Bank cheque or bKash/Nagad number the money goes to. */
    paymentRef: text("payment_ref"),
    /** Why the member is taking money out, as they said it. */
    reason: text("reason"),
    status: voucherStatusEnum("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Client-generated, so a double-clicked submit makes one request. */
    submitKey: text("submit_key"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Why it was rejected (required) or cancelled. */
    decisionNote: text("decision_note"),
    /** The journal entry an approval posted. */
    entryId: uuid("entry_id"),
  },
  (t) => [
    unique("savings_withdrawal_tenant_id").on(t.tenantId, t.id),
    unique("savings_withdrawal_submit_key").on(t.tenantId, t.submitKey),
    unique("savings_withdrawal_entry").on(t.tenantId, t.entryId),
    index("savings_withdrawal_status").on(t.tenantId, t.status, t.createdAt),
    index("savings_withdrawal_account").on(t.tenantId, t.accountId, t.createdAt),
    foreignKey({
      name: "savings_withdrawal_account_fk",
      columns: [t.tenantId, t.accountId],
      foreignColumns: [savingsAccount.tenantId, savingsAccount.id],
    }),
    foreignKey({
      name: "savings_withdrawal_requested_by_fk",
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "savings_withdrawal_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "savings_withdrawal_entry_fk",
      columns: [t.tenantId, t.entryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    check("savings_withdrawal_amount", sql`${t.amount} > 0`),
    check(
      "savings_withdrawal_wallet_ref",
      sql`${t.paymentMethod} <> 'mobile_wallet' OR length(trim(${t.paymentRef})) > 0`,
    ),
    check(
      "savings_withdrawal_decision_complete",
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    check("savings_withdrawal_approved_has_entry", sql`(${t.status} = 'approved') = (${t.entryId} IS NOT NULL)`),
    check(
      "savings_withdrawal_rejected_has_note",
      sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.decisionNote}, ''))) > 0`,
    ),
    // Maker-checker: a different user, not just a different role.
    check(
      "savings_withdrawal_checker_not_maker",
      sql`${t.status} NOT IN ('approved', 'rejected') OR ${t.decidedBy} <> ${t.requestedBy}`,
    ),
    check(
      "savings_withdrawal_cancelled_by_maker",
      sql`${t.status} <> 'cancelled' OR ${t.decidedBy} = ${t.requestedBy}`,
    ),
  ],
);
