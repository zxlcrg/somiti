import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { journalEntry, voucherStatusEnum } from "./ledger";
import { appUser, tenant } from "./tenancy";

/** The member transactions a correction can undo. */
export const correctionKindEnum = pgEnum("correction_kind", ["savings_deposit", "savings_withdrawal", "share_purchase", "loan_repayment"]);

/**
 * Undoing a member transaction recorded by mistake: one officer asks, with a
 * reason, and a different officer approves. Approval posts the reversal of the
 * original entry on the current business date; the original stays as it was.
 */
export const entryCorrection = pgTable(
  "entry_correction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    entryId: uuid("entry_id").notNull(),
    kind: correctionKindEnum("kind").notNull(),
    status: voucherStatusEnum("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    requestedOn: date("requested_on", { mode: "string" }).notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    reversalId: uuid("reversal_id"),
    submitKey: text("submit_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("entry_correction_tenant_id").on(t.tenantId, t.id),
    unique("entry_correction_submit_key").on(t.tenantId, t.submitKey),
    index("entry_correction_entry_idx").on(t.tenantId, t.entryId),
    foreignKey({ name: "entry_correction_entry_fk", columns: [t.tenantId, t.entryId], foreignColumns: [journalEntry.tenantId, journalEntry.id] }),
    foreignKey({ name: "entry_correction_reversal_fk", columns: [t.tenantId, t.reversalId], foreignColumns: [journalEntry.tenantId, journalEntry.id] }),
    foreignKey({ name: "entry_correction_requested_by_fk", columns: [t.tenantId, t.requestedBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    foreignKey({ name: "entry_correction_decided_by_fk", columns: [t.tenantId, t.decidedBy], foreignColumns: [appUser.tenantId, appUser.id] }),
    check("entry_correction_reason", sql`length(trim(${t.reason})) BETWEEN 3 AND 300`),
    check("entry_correction_checker_not_maker", sql`${t.decidedBy} IS NULL OR ${t.status} = 'cancelled' OR ${t.decidedBy} <> ${t.requestedBy}`),
    check("entry_correction_decided", sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`),
    check("entry_correction_posted", sql`(${t.status} = 'approved') = (${t.reversalId} IS NOT NULL)`),
    check("entry_correction_reject_note", sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.decisionNote}, ''))) > 0`),
  ],
);
