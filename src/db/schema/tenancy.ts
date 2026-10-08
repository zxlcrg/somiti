import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const localeEnum = pgEnum("locale", ["en", "bn"]);

export const roleEnum = pgEnum("staff_role", [
  "admin",
  "president",
  "secretary",
  "cashier",
  "field_collector",
  "member",
]);

/**
 * One row per somiti. RLS on this table matches `id` (not `tenant_id`)
 * against the current tenant, so a tenant can only ever see itself.
 */
export const tenant = pgTable(
  "tenant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    /** Language a new user or member starts with. */
    defaultLocale: localeEnum("default_locale").notNull().default("en"),
    timezone: text("timezone").notNull().default("Asia/Dhaka"),
    /** 7 = July, so the fiscal year runs July to June. */
    fiscalYearStartMonth: smallint("fiscal_year_start_month").notNull().default(7),
    /** The accounting date. Moves forward only at day-end close. */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** Last closed business day. Nothing may post on or before it. */
    lockedThrough: date("locked_through", { mode: "string" }),
    /** Price of one share, in paisa, as the bylaws set it. ৳100 until the somiti says otherwise. */
    sharePrice: bigint("share_price", { mode: "bigint" }).notNull().default(sql`10000`),
    /** What the somiti aims to collect each month (savings and loan repayments), in paisa; null until set. */
    collectionTarget: bigint("collection_target", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("tenant_has_name", sql`${t.nameEn} IS NOT NULL OR ${t.nameBn} IS NOT NULL`),
    check("tenant_fiscal_month", sql`${t.fiscalYearStartMonth} BETWEEN 1 AND 12`),
    check("tenant_share_price_positive", sql`${t.sharePrice} > 0`),
    check("tenant_collection_target_positive", sql`${t.collectionTarget} IS NULL OR ${t.collectionTarget} > 0`),
    check(
      "tenant_business_date_after_lock",
      sql`${t.lockedThrough} IS NULL OR ${t.businessDate} > ${t.lockedThrough}`,
    ),
  ],
);

/** Collection area. Every somiti has at least one; members and entries carry branch_id from day one. */
export const branch = pgTable(
  "branch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    code: text("code").notNull(),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("branch_tenant_id_id").on(t.tenantId, t.id),
    unique("branch_tenant_code").on(t.tenantId, t.code),
    check("branch_has_name", sql`${t.nameEn} IS NOT NULL OR ${t.nameBn} IS NOT NULL`),
  ],
);

/** Staff and members who sign in, with their phone and an SMS code (src/modules/auth). */
export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    branchId: uuid("branch_id"),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    phone: text("phone").notNull(),
    /** UI language for this user. NULL means "use the somiti default". */
    locale: localeEnum("locale"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("app_user_tenant_id_id").on(t.tenantId, t.id),
    unique("app_user_tenant_phone").on(t.tenantId, t.phone),
    foreignKey({
      name: "app_user_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branch.tenantId, branch.id],
    }),
    check("app_user_has_name", sql`${t.nameEn} IS NOT NULL OR ${t.nameBn} IS NOT NULL`),
  ],
);

/** A user may hold several roles; maker-checker compares users, not roles. */
export const userRole = pgTable(
  "user_role",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: uuid("user_id").notNull(),
    role: roleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId, t.role] }),
    foreignKey({
      name: "user_role_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
  ],
);

/**
 * Remembers client-generated request keys so a retried or double-synced
 * request never posts twice. `resultId` is the id of what the first
 * request created (for scope "ledger.post", a journal_entry id).
 */
export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    key: text("key").notNull(),
    scope: text("scope").notNull(),
    requestHash: text("request_hash").notNull(),
    resultId: uuid("result_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
