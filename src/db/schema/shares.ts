import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { journalEntry } from "./ledger";
import { member } from "./members";
import { appUser, tenant } from "./tenancy";

export const shareTxnKindEnum = pgEnum("share_txn_kind", ["purchase"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash", "bank", "mobile_wallet"]);

/**
 * Shares a member buys. The money is a journal entry (Dr cash, bank or
 * wallet; Cr share capital, on the member's line); this row adds what the
 * ledger doesn't hold: how many shares, at what price. Holdings are the
 * sum of these rows, leaving out any whose entry was reversed.
 *
 * Append-only, like the ledger itself. Exit refunds will add a second kind.
 */
export const shareTransaction = pgTable(
  "share_transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    memberId: uuid("member_id").notNull(),
    kind: shareTxnKindEnum("kind").notNull(),
    shares: integer("shares").notNull(),
    /** Price per share at the time, in paisa. */
    price: bigint("price", { mode: "bigint" }).notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    /** Bank slip or bKash/Nagad transaction ID. */
    paymentRef: text("payment_ref"),
    journalEntryId: uuid("journal_entry_id").notNull(),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("share_transaction_entry").on(t.tenantId, t.journalEntryId),
    foreignKey({
      name: "share_transaction_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    foreignKey({
      name: "share_transaction_entry_fk",
      columns: [t.tenantId, t.journalEntryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    foreignKey({
      name: "share_transaction_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    index("share_transaction_member").on(t.tenantId, t.memberId),
    check("share_transaction_shares", sql`${t.shares} BETWEEN 1 AND 100000`),
    check("share_transaction_price", sql`${t.price} > 0`),
    check("share_transaction_amount", sql`${t.amount} = ${t.shares}::bigint * ${t.price}`),
    check(
      "share_transaction_wallet_ref",
      sql`${t.paymentMethod} <> 'mobile_wallet' OR length(trim(${t.paymentRef})) > 0`,
    ),
  ],
);
