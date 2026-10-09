import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { journalEntry } from "./ledger";
import { member } from "./members";
import { depositChannelEnum } from "./savings";
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
/**
 * How a repayment is split inside each installment, oldest installment first
 * (architecture review: allocation order is a loan-product setting). Fines,
 * once loans have them, always come first.
 */
export const loanAllocationEnum = pgEnum("loan_allocation", ["interest_first", "principal_first"]);
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
    allocation: loanAllocationEnum("allocation").notNull().default("interest_first"),
    /** Fine per installment paid after its due date, in paisa; null means no fines. */
    lateFine: bigint("late_fine", { mode: "bigint" }),
    /** Share of the charge on installments not yet due that is let off when a loan is settled early, in basis points. */
    settlementRebateBp: integer("settlement_rebate_bp").notNull().default(0),
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
    check("loan_product_late_fine", sql`${t.lateFine} IS NULL OR ${t.lateFine} > 0`),
    check("loan_product_settlement_rebate", sql`${t.settlementRebateBp} BETWEEN 0 AND 10000`),
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
    allocation: loanAllocationEnum("allocation").notNull().default("interest_first"),
    lateFine: bigint("late_fine", { mode: "bigint" }),
    settlementRebateBp: integer("settlement_rebate_bp").notNull().default(0),
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
    /** The business day the last of it was repaid. */
    closedOn: date("closed_on", { mode: "string" }),
    /**
     * Set on a loan brought in from the paper books while already running:
     * the business day it was imported. Such a loan's principal and schedule
     * are what was still owed that day; the originals are kept beside them.
     */
    importedOn: date("imported_on", { mode: "string" }),
    originalPrincipal: bigint("original_principal", { mode: "bigint" }),
    originalInstallments: integer("original_installments"),
    /** Principal and charge repaid on paper before the import. */
    paidBefore: bigint("paid_before", { mode: "bigint" }),
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
    check("loan_settlement_rebate", sql`${t.settlementRebateBp} BETWEEN 0 AND 10000`),
    check("loan_fee", sql`${t.processingFee} >= 0 AND ${t.processingFee} < ${t.principal}`),
    // Maker-checker is a different person, not a different role (architecture review).
    // An imported loan was decided on paper long ago; the admin who brings it in is its only officer here.
    check(
      "loan_checker_not_maker",
      sql`${t.importedOn} IS NOT NULL OR ${t.status} NOT IN ('approved', 'rejected', 'disbursed', 'closed') OR ${t.decidedBy} <> ${t.appliedBy}`,
    ),
    check(
      "loan_imported",
      sql`(${t.importedOn} IS NULL) = (${t.originalPrincipal} IS NULL)
          AND (${t.importedOn} IS NULL) = (${t.originalInstallments} IS NULL)
          AND (${t.importedOn} IS NULL) = (${t.paidBefore} IS NULL)
          AND (${t.importedOn} IS NULL OR (${t.originalPrincipal} >= ${t.principal} AND ${t.paidBefore} >= 0))`,
    ),
    check(
      "loan_decided",
      sql`(${t.status} = 'applied') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    check("loan_closed", sql`(${t.status} = 'closed') = (${t.closedOn} IS NOT NULL)`),
    check("loan_reject_note", sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.decisionNote}, ''))) > 0`),
    check(
      "loan_disbursed",
      sql`(${t.status} IN ('disbursed', 'closed')) = (${t.entryId} IS NOT NULL)
          AND (${t.entryId} IS NULL) = (${t.disbursedOn} IS NULL)
          AND (${t.entryId} IS NULL) = (${t.disbursedBy} IS NULL)
          AND (${t.importedOn} IS NOT NULL OR (${t.entryId} IS NULL) = (${t.paymentMethod} IS NULL))`,
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
    /** 0 for the schedule written at disbursement; n for the one written by the loan's nth rescheduling. */
    scheduleNo: integer("schedule_no").notNull().default(0),
  },
  (t) => [
    unique("loan_installment_seq").on(t.tenantId, t.loanId, t.seq),
    foreignKey({ name: "loan_installment_loan_fk", columns: [t.tenantId, t.loanId], foreignColumns: [loan.tenantId, loan.id] }),
    check("loan_installment_seq_positive", sql`${t.seq} > 0`),
    check("loan_installment_schedule_no", sql`${t.scheduleNo} >= 0`),
    check("loan_installment_amounts", sql`${t.principal} >= 0 AND ${t.interest} >= 0 AND ${t.principal} + ${t.interest} > 0`),
  ],
);

/**
 * Money a member paid against a loan. One row per receipt; the lines below
 * say which installments it settled. Interest is income when the cash
 * arrives (cash basis, architecture review).
 */
export const loanRepayment = pgTable(
  "loan_repayment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    loanId: uuid("loan_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    principal: bigint("principal", { mode: "bigint" }).notNull(),
    interest: bigint("interest", { mode: "bigint" }).notNull(),
    /** Late fine taken on top of the amount, booked to Fine income. */
    fine: bigint("fine", { mode: "bigint" }).notNull().default(sql`0`),
    /** Charge let off by an early settlement; never posted (charges are income only when paid). */
    rebate: bigint("rebate", { mode: "bigint" }).notNull().default(sql`0`),
    /** True when this payment settled the loan early, at the settlement figure. */
    settlement: boolean("settlement").notNull().default(false),
    channel: depositChannelEnum("channel").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    paymentRef: text("payment_ref"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("loan_repayment_tenant_id").on(t.tenantId, t.id),
    unique("loan_repayment_entry").on(t.tenantId, t.journalEntryId),
    index("loan_repayment_loan").on(t.tenantId, t.loanId, t.createdAt),
    index("loan_repayment_collector").on(t.tenantId, t.createdBy, t.businessDate),
    foreignKey({ name: "loan_repayment_loan_fk", columns: [t.tenantId, t.loanId], foreignColumns: [loan.tenantId, loan.id] }),
    foreignKey({ name: "loan_repayment_entry_fk", columns: [t.tenantId, t.journalEntryId], foreignColumns: [journalEntry.tenantId, journalEntry.id] }),
    foreignKey({ name: "loan_repayment_created_by_fk", columns: [t.tenantId, t.createdBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    check("loan_repayment_amounts", sql`${t.amount} > 0 AND ${t.principal} >= 0 AND ${t.interest} >= 0 AND ${t.fine} >= 0 AND ${t.rebate} >= 0 AND ${t.amount} = ${t.principal} + ${t.interest}`),
    check("loan_repayment_rebate", sql`${t.rebate} = 0 OR ${t.settlement}`),
    check("loan_repayment_collector_cash", sql`${t.channel} = 'office' OR ${t.paymentMethod} = 'cash'`),
  ],
);

/** How one repayment was split across installments. */
export const loanRepaymentLine = pgTable(
  "loan_repayment_line",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    repaymentId: uuid("repayment_id").notNull(),
    loanId: uuid("loan_id").notNull(),
    seq: integer("seq").notNull(),
    principal: bigint("principal", { mode: "bigint" }).notNull(),
    interest: bigint("interest", { mode: "bigint" }).notNull(),
    /** Charge on this installment let off by an early settlement. */
    rebate: bigint("rebate", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (t) => [
    unique("loan_repayment_line_seq").on(t.tenantId, t.repaymentId, t.seq),
    index("loan_repayment_line_installment").on(t.tenantId, t.loanId, t.seq),
    foreignKey({ name: "loan_repayment_line_repayment_fk", columns: [t.tenantId, t.repaymentId], foreignColumns: [loanRepayment.tenantId, loanRepayment.id] }),
    foreignKey({
      name: "loan_repayment_line_installment_fk",
      columns: [t.tenantId, t.loanId, t.seq],
      foreignColumns: [loanInstallment.tenantId, loanInstallment.loanId, loanInstallment.seq],
    }),
    check("loan_repayment_line_amounts", sql`${t.principal} >= 0 AND ${t.interest} >= 0 AND ${t.rebate} >= 0 AND ${t.principal} + ${t.interest} + ${t.rebate} > 0`),
  ],
);

/**
 * The late fine on one installment: charged once, by the first repayment
 * that pays into it after its due date. A waived fine is kept too (amount
 * 0), so a later part-payment doesn't charge it again.
 */
export const loanFine = pgTable(
  "loan_fine",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    loanId: uuid("loan_id").notNull(),
    seq: integer("seq").notNull(),
    repaymentId: uuid("repayment_id").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    waived: boolean("waived").notNull().default(false),
  },
  (t) => [
    unique("loan_fine_installment").on(t.tenantId, t.loanId, t.seq),
    foreignKey({
      name: "loan_fine_installment_fk",
      columns: [t.tenantId, t.loanId, t.seq],
      foreignColumns: [loanInstallment.tenantId, loanInstallment.loanId, loanInstallment.seq],
    }),
    foreignKey({ name: "loan_fine_repayment_fk", columns: [t.tenantId, t.repaymentId], foreignColumns: [loanRepayment.tenantId, loanRepayment.id] }),
    check("loan_fine_amount", sql`(${t.waived} AND ${t.amount} = 0) OR (NOT ${t.waived} AND ${t.amount} > 0)`),
  ],
);

/**
 * A new schedule for what a running loan still owes. No money moves: what
 * was left on the old installments is recorded as moved (the lines below)
 * and written again as new installments, with any extra charge agreed for
 * the longer term. Charges stay income only when paid.
 */
export const loanReschedule = pgTable(
  "loan_reschedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    loanId: uuid("loan_id").notNull(),
    /** 1 for the loan's first rescheduling; matches loan_installment.schedule_no. */
    no: integer("no").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** Principal and charge moved off the old installments. */
    principal: bigint("principal", { mode: "bigint" }).notNull(),
    interest: bigint("interest", { mode: "bigint" }).notNull(),
    /** Charge added for the new term; 0 for none. */
    extraCharge: bigint("extra_charge", { mode: "bigint" }).notNull().default(sql`0`),
    installments: integer("installments").notNull(),
    firstDueOn: date("first_due_on", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("loan_reschedule_tenant_id").on(t.tenantId, t.id),
    unique("loan_reschedule_no").on(t.tenantId, t.loanId, t.no),
    foreignKey({ name: "loan_reschedule_loan_fk", columns: [t.tenantId, t.loanId], foreignColumns: [loan.tenantId, loan.id] }),
    foreignKey({ name: "loan_reschedule_created_by_fk", columns: [t.tenantId, t.createdBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    check("loan_reschedule_no_positive", sql`${t.no} > 0`),
    check("loan_reschedule_amounts", sql`${t.principal} >= 0 AND ${t.interest} >= 0 AND ${t.extraCharge} >= 0 AND ${t.principal} + ${t.interest} > 0`),
    check("loan_reschedule_installments", sql`${t.installments} BETWEEN 1 AND 520`),
    check("loan_reschedule_first_due", sql`${t.firstDueOn} > ${t.businessDate}`),
    check("loan_reschedule_reason", sql`length(trim(${t.reason})) BETWEEN 3 AND 300`),
  ],
);

/** What one rescheduling moved off one old installment. */
export const loanRescheduleLine = pgTable(
  "loan_reschedule_line",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    rescheduleId: uuid("reschedule_id").notNull(),
    loanId: uuid("loan_id").notNull(),
    seq: integer("seq").notNull(),
    principal: bigint("principal", { mode: "bigint" }).notNull(),
    interest: bigint("interest", { mode: "bigint" }).notNull(),
  },
  (t) => [
    unique("loan_reschedule_line_seq").on(t.tenantId, t.rescheduleId, t.seq),
    index("loan_reschedule_line_installment").on(t.tenantId, t.loanId, t.seq),
    foreignKey({ name: "loan_reschedule_line_reschedule_fk", columns: [t.tenantId, t.rescheduleId], foreignColumns: [loanReschedule.tenantId, loanReschedule.id] }),
    foreignKey({
      name: "loan_reschedule_line_installment_fk",
      columns: [t.tenantId, t.loanId, t.seq],
      foreignColumns: [loanInstallment.tenantId, loanInstallment.loanId, loanInstallment.seq],
    }),
    check("loan_reschedule_line_amounts", sql`${t.principal} >= 0 AND ${t.interest} >= 0 AND ${t.principal} + ${t.interest} > 0`),
  ],
);
