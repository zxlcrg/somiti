import { jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { tenant } from "./tenancy";

/** Append-only record of who did what, when, and from which device. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    device: text("device"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant_entity").on(t.tenantId, t.entityType, t.entityId)],
);
