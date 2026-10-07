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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appUser, branch, tenant } from "./tenancy";
import { member } from "./members";

export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
]);

/** Where an entry came from. Later modules add their own values (deposit, disbursement, ...). */
export const entrySourceEnum = pgEnum("entry_source", [
  "opening_balance",
  "manual_voucher",
  "share_purchase",
  "savings_deposit",
  "savings_withdrawal",
  "collector_handover",
  "day_close",
  "loan_disbursement",
  "reversal",
  "system",
]);

export const periodStatusEnum = pgEnum("period_status", ["open", "closed"]);

/** Chart of accounts. Names are tenant data, so they are stored in both languages. */
export const ledgerAccount = pgTable(
  "ledger_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    code: text("code").notNull(),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    type: accountTypeEnum("type").notNull(),
    parentId: uuid("parent_id"),
    /** Stable key the posting rules use, e.g. "cash_in_hand". NULL for accounts a somiti adds itself. */
    systemKey: text("system_key"),
    /** Header accounts group others and cannot be posted to. */
    isPostable: boolean("is_postable").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_account_tenant_id_id").on(t.tenantId, t.id),
    unique("ledger_account_tenant_code").on(t.tenantId, t.code),
    unique("ledger_account_tenant_system_key").on(t.tenantId, t.systemKey),
    foreignKey({
      name: "ledger_account_parent_fk",
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
    }),
    check("ledger_account_has_name", sql`${t.nameEn} IS NOT NULL OR ${t.nameBn} IS NOT NULL`),
  ],
);

/** Fiscal years (or shorter periods). Posting is allowed only into an open period. */
export const fiscalPeriod = pgTable(
  "fiscal_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    status: periodStatusEnum("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("fiscal_period_tenant_id_id").on(t.tenantId, t.id),
    check("fiscal_period_dates", sql`${t.endDate} >= ${t.startDate}`),
    foreignKey({
      name: "fiscal_period_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    // Overlap is prevented by an exclusion constraint in the invariants migration.
  ],
);

/** Hands out gapless voucher numbers per somiti. */
export const entryCounter = pgTable("entry_counter", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenant.id),
  lastNo: bigint("last_no", { mode: "bigint" }).notNull(),
});

/**
 * One balanced money event. Append-only: a mistake is fixed by a reversal
 * entry that points to the original through `reversesId`.
 */
export const journalEntry = pgTable(
  "journal_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    branchId: uuid("branch_id").notNull(),
    /** Voucher number, sequential per somiti. */
    entryNo: bigint("entry_no", { mode: "bigint" }).notNull(),
    /** Accounting date. Reports use this; audits use it together with createdAt. */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    source: entrySourceEnum("source").notNull(),
    narration: text("narration").notNull(),
    reversesId: uuid("reverses_id"),
    createdBy: uuid("created_by").notNull(),
    /** Set by the database at insert; any value the app sends is overwritten. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Transaction that created the entry, set by the database. Lines can only
     * be added in that same transaction, so nobody can append a balanced pair
     * to an old entry in a closed period.
     */
    createdTxid: bigint("created_txid", { mode: "bigint" })
      .notNull()
      .default(sql`txid_current()`),
  },
  (t) => [
    unique("journal_entry_tenant_id_id").on(t.tenantId, t.id),
    unique("journal_entry_tenant_entry_no").on(t.tenantId, t.entryNo),
    index("journal_entry_tenant_business_date").on(t.tenantId, t.businessDate),
    // An entry can be reversed at most once.
    uniqueIndex("journal_entry_reverses_once")
      .on(t.tenantId, t.reversesId)
      .where(sql`${t.reversesId} IS NOT NULL`),
    foreignKey({
      name: "journal_entry_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branch.tenantId, branch.id],
    }),
    foreignKey({
      name: "journal_entry_reverses_fk",
      columns: [t.tenantId, t.reversesId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: "journal_entry_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    check("journal_entry_reversal_source", sql`(${t.source} = 'reversal') = (${t.reversesId} IS NOT NULL)`),
  ],
);

/**
 * One debit or one credit, in paisa. Lines may point at the member,
 * savings account or loan they concern, so per-member sub-ledgers come
 * from the same data. member_id has its foreign key; savings accounts
 * and loans add theirs when those tables arrive (M2, M3).
 */
export const journalLine = pgTable(
  "journal_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    entryId: uuid("entry_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: bigint("debit", { mode: "bigint" }).notNull().default(sql`0`),
    credit: bigint("credit", { mode: "bigint" }).notNull().default(sql`0`),
    memberId: uuid("member_id"),
    savingsAccountId: uuid("savings_account_id"),
    loanId: uuid("loan_id"),
    memo: text("memo"),
  },
  (t) => [
    unique("journal_line_entry_line_no").on(t.tenantId, t.entryId, t.lineNo),
    index("journal_line_tenant_account").on(t.tenantId, t.accountId),
    foreignKey({
      name: "journal_line_entry_fk",
      columns: [t.tenantId, t.entryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    foreignKey({
      name: "journal_line_account_fk",
      columns: [t.tenantId, t.accountId],
      foreignColumns: [ledgerAccount.tenantId, ledgerAccount.id],
    }),
    foreignKey({
      name: "journal_line_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    // Exactly one side is a positive amount.
    check(
      "journal_line_one_side",
      sql`${t.debit} >= 0 AND ${t.credit} >= 0 AND (${t.debit} > 0) <> (${t.credit} > 0)`,
    ),
  ],
);

export const voucherStatusEnum = pgEnum("voucher_status", ["pending", "approved", "rejected", "cancelled"]);

/**
 * A manual voucher waiting for a second officer (maker-checker). Nothing
 * reaches the ledger until a different user approves it; approval posts
 * one journal entry and records it in `entryId`. The database refuses an
 * approval or rejection by the person who made the voucher.
 */
export const voucher = pgTable(
  "voucher",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    branchId: uuid("branch_id").notNull(),
    narration: text("narration").notNull(),
    /** Sum of the debit lines, in paisa; kept for lists and the approval screen. */
    total: bigint("total", { mode: "bigint" }).notNull(),
    status: voucherStatusEnum("status").notNull().default("pending"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Like journal_entry: lines can only be added in the transaction that made the voucher. */
    createdTxid: bigint("created_txid", { mode: "bigint" })
      .notNull()
      .default(sql`txid_current()`),
    /** Client-generated, so a double-clicked submit makes one voucher. */
    submitKey: text("submit_key"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Why it was rejected (required) or cancelled. */
    decisionNote: text("decision_note"),
    /** The journal entry an approval posted. */
    entryId: uuid("entry_id"),
  },
  (t) => [
    unique("voucher_tenant_id_id").on(t.tenantId, t.id),
    unique("voucher_tenant_submit_key").on(t.tenantId, t.submitKey),
    unique("voucher_tenant_entry").on(t.tenantId, t.entryId),
    index("voucher_tenant_status_created").on(t.tenantId, t.status, t.createdAt),
    foreignKey({
      name: "voucher_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branch.tenantId, branch.id],
    }),
    foreignKey({
      name: "voucher_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "voucher_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "voucher_entry_fk",
      columns: [t.tenantId, t.entryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    check("voucher_total_positive", sql`${t.total} > 0`),
    check(
      "voucher_decision_complete",
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    check("voucher_approved_has_entry", sql`(${t.status} = 'approved') = (${t.entryId} IS NOT NULL)`),
    check(
      "voucher_rejected_has_note",
      sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.decisionNote}, ''))) > 0`,
    ),
    // Maker-checker: a different user, not just a different role.
    check(
      "voucher_checker_not_maker",
      sql`${t.status} NOT IN ('approved', 'rejected') OR ${t.decidedBy} <> ${t.createdBy}`,
    ),
    // Only the maker can withdraw their own voucher.
    check("voucher_cancelled_by_maker", sql`${t.status} <> 'cancelled' OR ${t.decidedBy} = ${t.createdBy}`),
  ],
);

/** One debit or credit of a voucher, in paisa. Copied to journal_line on approval. */
export const voucherLine = pgTable(
  "voucher_line",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    voucherId: uuid("voucher_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    debit: bigint("debit", { mode: "bigint" }).notNull().default(sql`0`),
    credit: bigint("credit", { mode: "bigint" }).notNull().default(sql`0`),
    memo: text("memo"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.voucherId, t.lineNo] }),
    foreignKey({
      name: "voucher_line_voucher_fk",
      columns: [t.tenantId, t.voucherId],
      foreignColumns: [voucher.tenantId, voucher.id],
    }),
    foreignKey({
      name: "voucher_line_account_fk",
      columns: [t.tenantId, t.accountId],
      foreignColumns: [ledgerAccount.tenantId, ledgerAccount.id],
    }),
    check(
      "voucher_line_one_side",
      sql`${t.debit} >= 0 AND ${t.credit} >= 0 AND (${t.debit} > 0) <> (${t.credit} > 0)`,
    ),
  ],
);
