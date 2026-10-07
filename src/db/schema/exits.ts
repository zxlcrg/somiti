import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { journalEntry, voucherStatusEnum } from "./ledger";
import { member } from "./members";
import { savingsAccount } from "./savings";
import { paymentMethodEnum } from "./shares";
import { appUser, tenant } from "./tenancy";

export const exitPayoutKindEnum = pgEnum("exit_payout_kind", ["shares", "savings"]);

/**
 * A member leaving the somiti. Exit is a settlement, and money going out
 * takes two people (architecture doc, "Security and controls"): one
 * officer enters the request, a different one approves it. Approval pays
 * back the member's share capital and every savings balance, closes their
 * savings accounts and marks them exited (members/exits.ts).
 *
 * The amounts are worked out again at approval, since deposits may come
 * in between; they are stored once known. At most one request per member
 * is pending at a time. Rows are never deleted, and only the decision
 * changes (drizzle/0029).
 */
export const memberExit = pgTable(
  "member_exit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    memberId: uuid("member_id").notNull(),
    /** Why the member is leaving, as recorded by the officer. */
    reason: text("reason").notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    /** Bank account or bKash/Nagad number the settlement goes to. */
    paymentRef: text("payment_ref"),
    status: voucherStatusEnum("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Client-generated, so a double-clicked submit makes one request. */
    submitKey: text("submit_key"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Why it was rejected (required) or cancelled. */
    decisionNote: text("decision_note"),
    /** What approval paid out, in paisa. */
    shareRefund: bigint("share_refund", { mode: "bigint" }),
    savingsPayout: bigint("savings_payout", { mode: "bigint" }),
  },
  (t) => [
    unique("member_exit_tenant_id").on(t.tenantId, t.id),
    unique("member_exit_submit_key").on(t.tenantId, t.submitKey),
    uniqueIndex("member_exit_one_pending")
      .on(t.tenantId, t.memberId)
      .where(sql`${t.status} = 'pending'`),
    index("member_exit_status").on(t.tenantId, t.status, t.createdAt),
    foreignKey({
      name: "member_exit_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    foreignKey({
      name: "member_exit_requested_by_fk",
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "member_exit_decided_by_fk",
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    check("member_exit_reason", sql`length(trim(${t.reason})) > 0`),
    check("member_exit_wallet_ref", sql`${t.paymentMethod} <> 'mobile_wallet' OR length(trim(${t.paymentRef})) > 0`),
    check(
      "member_exit_decision_complete",
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL) AND (${t.decidedBy} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    check(
      "member_exit_approved_amounts",
      sql`(${t.status} = 'approved') = (${t.shareRefund} IS NOT NULL) AND (${t.shareRefund} IS NULL) = (${t.savingsPayout} IS NULL)`,
    ),
    check("member_exit_amounts_not_negative", sql`coalesce(${t.shareRefund}, 0) >= 0 AND coalesce(${t.savingsPayout}, 0) >= 0`),
    check(
      "member_exit_rejected_has_note",
      sql`${t.status} <> 'rejected' OR length(trim(coalesce(${t.decisionNote}, ''))) > 0`,
    ),
    // Maker-checker: a different user, not just a different role.
    check("member_exit_checker_not_maker", sql`${t.status} NOT IN ('approved', 'rejected') OR ${t.decidedBy} <> ${t.requestedBy}`),
    check("member_exit_cancelled_by_maker", sql`${t.status} <> 'cancelled' OR ${t.decidedBy} = ${t.requestedBy}`),
  ],
);

/**
 * The entries an approved exit posted: one for the share refund and one
 * per savings account paid out (each savings payout is also that account's
 * last passbook line). Append-only.
 */
export const memberExitPayout = pgTable(
  "member_exit_payout",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    exitId: uuid("exit_id").notNull(),
    kind: exitPayoutKindEnum("kind").notNull(),
    savingsAccountId: uuid("savings_account_id"),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
  },
  (t) => [
    unique("member_exit_payout_entry").on(t.tenantId, t.journalEntryId),
    index("member_exit_payout_exit").on(t.tenantId, t.exitId),
    foreignKey({
      name: "member_exit_payout_exit_fk",
      columns: [t.tenantId, t.exitId],
      foreignColumns: [memberExit.tenantId, memberExit.id],
    }),
    foreignKey({
      name: "member_exit_payout_account_fk",
      columns: [t.tenantId, t.savingsAccountId],
      foreignColumns: [savingsAccount.tenantId, savingsAccount.id],
    }),
    foreignKey({
      name: "member_exit_payout_entry_fk",
      columns: [t.tenantId, t.journalEntryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    check("member_exit_payout_amount", sql`${t.amount} > 0`),
    check("member_exit_payout_account", sql`(${t.kind} = 'savings') = (${t.savingsAccountId} IS NOT NULL)`),
  ],
);
