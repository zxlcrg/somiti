import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { appUser, tenant } from "./tenancy";

/**
 * One SMS sign-in code. Only an HMAC of the code is stored. A challenge is
 * spent by a correct code (consumed_at) or by too many wrong ones (attempts).
 */
export const otpChallenge = pgTable(
  "otp_challenge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: uuid("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: smallint("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "otp_challenge_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    index("otp_challenge_user_created").on(t.tenantId, t.userId, t.createdAt),
    check("otp_challenge_attempts", sql`${t.attempts} >= 0`),
  ],
);

/**
 * A signed-in browser. The cookie holds a random token; only its SHA-256
 * is stored, so a database leak does not hand out live sessions.
 */
export const userSession = pgTable(
  "user_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: uuid("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    device: text("device"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "user_session_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
  ],
);
