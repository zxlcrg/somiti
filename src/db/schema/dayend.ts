import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { journalEntry } from "./ledger";
import { appUser, tenant } from "./tenancy";

/**
 * A closed business day: the cashier's count of the cash drawer against
 * what the books say should be there. A difference is posted to Cash over /
 * short in `entry_id` before the day is locked. One per day; append-only.
 */
export const dayClose = pgTable(
  "day_close",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** Cash in hand per the books at close, in paisa. */
    expected: bigint("expected", { mode: "bigint" }).notNull(),
    /** Cash counted in the drawer, in paisa. */
    counted: bigint("counted", { mode: "bigint" }).notNull(),
    /** Notes and coins counted, as { "500": 3, ... }, plus loose change in paisa under "other". */
    breakdown: jsonb("breakdown").$type<Record<string, number>>().notNull(),
    /** Over/short entry, when the count differs from the books. */
    entryId: uuid("entry_id"),
    note: text("note"),
    closedBy: uuid("closed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("day_close_date").on(t.tenantId, t.businessDate),
    foreignKey({
      name: "day_close_entry_fk",
      columns: [t.tenantId, t.entryId],
      foreignColumns: [journalEntry.tenantId, journalEntry.id],
    }),
    foreignKey({
      name: "day_close_closed_by_fk",
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    check("day_close_counted", sql`${t.counted} >= 0`),
    check("day_close_difference_posted", sql`(${t.counted} = ${t.expected}) = (${t.entryId} IS NULL)`),
    check("day_close_difference_explained", sql`${t.counted} = ${t.expected} OR ${t.note} IS NOT NULL`),
  ],
);
