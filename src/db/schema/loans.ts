import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { journalEntry } from "./ledger";
import { member } from "./members";
import { paymentMethodEnum } from "./shares";
import { appUser, tenant } from "./tenancy";

/**
 * Flat: interest on the full principal for the whole term, spread evenly.
 * Declining: interest on what is still owed each period, with equal installments.
 */
export const loanMethodEnum = pgEnum("loan_method", ["flat", "declining"]);
export const loanFrequencyEnum = pgEnum("loan_frequency", ["weekly", "monthly"]);
/** Same maths, different word on screens and papers (architecture review, open decisions). */
export const loanChargeLabelEnum = pgEnum("loan_charge_label", ["interest", "service_charge"]);
/**
 * applied → approved → disbursed → closed, or applied/approved → rejected/cancelled.
 * The guard trigger in 0029 enforces the moves.
 */
export const loanStatusEnum = pgEnum("loan_status", ["applied", "approved", "rejected", "cancelled", "disbursed", "closed"]);

/** A loan product is configuration, not code: method, yearly rate, installment rhythm and limits. */
export const loanProduct = pgTable(
  "loan_product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameBn: text("name_bn"),
    method: loanMethodEnum("method").notNull(),
    chargeLabel: loanChargeLabelEnum("charge_label").notNull().default("service_charge"),
    /** Yearly rate in basis points: 1200 = 12% a year. */
    rateBp: integer("rate_bp").notNull(),
    frequency: loanFrequencyEnum("frequency").notNull(),
    minAmount: bigint("min_amount", { mode: "bigint" }).notNull(),
    maxAmount: bigint("max_amount", { mode: "bigint" }).notNull(),
    maxInstallments: integer("max_installments").notNull(),
    /** Taken once at disbursement, in basis points of the principal; 0 for none. */
    processingFeeBp: integer("processing_fee_bp").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("loan_product_tenant_id").on(t.tenantId, t.id),
    unique("loan_product_code").on(t.tenantId, t.code),
    foreignKey({ name: "loan_product_created_by_fk", columns: [t.tenantId, t.createdBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    check("loan_product_code_format", sql`${t.code} ~ '^[A-Z0-9-]{1,12}$'`),
    check("loan_product_name", sql`length(trim(${t.nameEn})) BETWEEN 1 AND 80`),
    check("loan_product_rate", sql`${t.rateBp} BETWEEN 0 AND 10000`),
    check("loan_product_amounts", sql`${t.minAmount} > 0 AND ${t.maxAmount} >= ${t.minAmount}`),
    check("loan_product_installments", sql`${t.maxInstallments} BETWEEN 1 AND 520`),
    check("loan_product_fee", sql`${t.processingFeeBp} BETWEEN 0 AND 1000`),
  ],
);

/**
 * One loan from application to close. Terms are copied from the product when
 * the member applies, so later product changes never move a live loan.
 */
export const loan = pgTable(
  "loan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    /** Gap-free per somiti, printed on the loan card. */
    loanNo: integer("loan_no").notNull(),
    memberId: uuid("member_id").notNull(),
    productId: uuid("product_id").notNull(),
    principal: bigint("principal", { mode: "bigint" }).notNull(),
    method: loanMethodEnum("method").notNull(),
    rateBp: integer("rate_bp").notNull(),
    frequency: loanFrequencyEnum("frequency").notNull(),
    installments: integer("installments").notNull(),
    processingFee: bigint("processing_fee", { mode: "bigint" }).notNull(),
    purpose: text("purpose"),
    status: loanStatusEnum("status").notNull().default("applied"),
    appliedBy: uuid("applied_by").notNull(),
    appliedOn: date("applied_on", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Client-generated, so a double-clicked submit makes one application. */
    submitKey: text("submit_key"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    /** "Approved in the committee meeting on …"; minutes stay on paper for now. */
    meetingOn: date("meeting_on", { mode: "string" }),
    disbursedBy: uuid("disbursed_by"),
    disbursedOn: date("disbursed_on", { mode: "string" }),
    paymentMethod: paymentMethodEnum("payment_method"),
    paymentRef: text("payment_ref"),
    entryId: uuid("entry_id"),
  },
  (t) => [
    unique("loan_tenant_id").on(t.tenantId, t.id),
    unique("loan_no").on(t.tenantId, t.loanNo),
    unique("loan_submit_key").on(t.tenantId, t.submitKey),
    unique("loan_entry").on(t.tenantId, t.entryId),
    index("loan_member").on(t.tenantId, t.memberId),
    index("loan_status").on(t.tenantId, t.status, t.createdAt),
    foreignKey({ name: "loan_member_fk", columns: [t.tenantId, t.memberId], foreignColumns: [member.tenantId, member.id] }),
    foreignKey({ name: "loan_product_fk", columns: [t.tenantId, t.productId], foreignColumns: [loanProduct.tenantId, loanProduct.id] }),
    foreignKey({ name: "loan_applied_by_fk", columns: [t.tenantId, t.appliedBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    foreignKey({ name: "loan_decided_by_fk", columns: [t.tenantId, t.decidedBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    foreignKey({ name: "loan_disbursed_by_fk", columns: [t.tenantId, t.disbursedBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    foreignKey({ name: "loan_entry_fk", columns: [t.tenantId, t.entryId], foreignColumns: [journalEntry.tenantId, journalEntry.id] }),
    check("loan_no_positive", sql`${t.loanNo} > 0`),
    check("loan_principal", sql`${t.principal} > 0`),
    check("loan_rate", sql`${t.rateBp} BETWEEN 0 AND 10000`),
    check("loan_installments", sql`${t.installments} BETWEEN 1 AND 520`),
    check("loan_fee", sql`${t.processingFee} >= 0 AND ${t.processingFee} < ${t.principal}`),
    // Maker-checker is a different person, not a different role (architecture review).
    check(
      "loan_checker_not_maker",
      sql`${t.status} NOT IN ('approved', 'rejected', 'disbursed', 'closed') OR ${t.decidedBy} <> ${t.appliedBy}`,
    ),
    check(
      "loan_decided",
      sql`(${t.status} = 'applied') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    check("loan_reject_note", sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.decisionNote}, ''))) > 0`),
    check(
      "loan_disbursed",
      sql`(${t.status} IN ('disbursed', 'closed')) = (${t.entryId} IS NOT NULL)
          AND (${t.entryId} IS NULL) = (${t.disbursedOn} IS NULL)
          AND (${t.entryId} IS NULL) = (${t.disbursedBy} IS NULL)
          AND (${t.entryId} IS NULL) = (${t.paymentMethod} IS NULL)`,
    ),
  ],
);

/**
 * The repayment schedule, written once at disbursement. These are contractual
 * records, so they are stored rather than computed (architecture review, dues).
 */
export const loanInstallment = pgTable(
  "loan_installment",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    loanId: uuid("loan_id").notNull(),
    seq: integer("seq").notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    principal: bigint("principal", { mode: "bigint" }).notNull(),
    interest: bigint("interest", { mode: "bigint" }).notNull(),
  },
  (t) => [
    unique("loan_installment_seq").on(t.tenantId, t.loanId, t.seq),
    foreignKey({ name: "loan_installment_loan_fk", columns: [t.tenantId, t.loanId], foreignColumns: [loan.tenantId, loan.id] }),
    check("loan_installment_seq_positive", sql`${t.seq} > 0`),
    check("loan_installment_amounts", sql`${t.principal} >= 0 AND ${t.interest} >= 0 AND ${t.principal} + ${t.interest} > 0`),
  ],
);
