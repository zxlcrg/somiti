import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { member } from "./members";
import { tenant } from "./tenancy";

export const smsKindEnum = pgEnum("sms_kind", ["deposit", "withdrawal"]);
export const smsStatusEnum = pgEnum("sms_status", ["queued", "sent", "failed"]);

/**
 * Text messages to members, written in the same transaction as the money
 * movement they report and delivered afterwards, so a gateway outage never
 * blocks a deposit and a message is never sent for one that rolled back.
 * One per kind and journal entry. Rows are never deleted.
 */
export const smsOutbox = pgTable(
  "sms_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    memberId: uuid("member_id").notNull(),
    toPhone: text("to_phone").notNull(),
    body: text("body").notNull(),
    kind: smsKindEnum("kind").notNull(),
    /** The journal entry the message reports. */
    refId: uuid("ref_id").notNull(),
    status: smsStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    unique("sms_outbox_ref").on(t.tenantId, t.kind, t.refId),
    foreignKey({
      name: "sms_outbox_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    index("sms_outbox_queued").on(t.tenantId, t.status, t.createdAt),
    check("sms_outbox_sent_at", sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
  ],
);
