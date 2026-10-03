import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appUser, branch, localeEnum, tenant } from "./tenancy";

export const memberStatusEnum = pgEnum("member_status", ["active", "exited", "deceased"]);
export const nomineeRelationEnum = pgEnum("nominee_relation", [
  "spouse",
  "son",
  "daughter",
  "father",
  "mother",
  "brother",
  "sister",
  "other",
]);
export const guardianRelationEnum = pgEnum("guardian_relation", ["father", "husband"]);

/**
 * A person admitted to the somiti. Only admitted members may hold savings
 * (Cooperative Societies Rules), so savings accounts and loans hang off this.
 *
 * Names are kept in both scripts, as KYC papers use them; at least one is
 * required. The NID is stored encrypted (src/modules/members/nid.ts) with a
 * keyed hash so a duplicate can be refused without decrypting anything.
 * Members are never deleted: exit and death are statuses.
 */
export const member = pgTable(
  "member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    branchId: uuid("branch_id").notNull(),
    /** Each somiti numbers its own members from 1. */
    memberNo: integer("member_no").notNull(),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    guardianRelation: guardianRelationEnum("guardian_relation"),
    guardianNameEn: text("guardian_name_en"),
    guardianNameBn: text("guardian_name_bn"),
    /** +8801XXXXXXXXX; where SMS receipts go. */
    phone: text("phone").notNull(),
    nidCipher: text("nid_cipher"),
    nidHash: text("nid_hash"),
    /** For showing "•••• 1234" without decrypting. */
    nidLast4: text("nid_last4"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    address: text("address"),
    /** Language of this member's SMS, receipts and passbook. NULL means the somiti default. */
    commLocale: localeEnum("comm_locale"),
    admissionDate: date("admission_date", { mode: "string" }).notNull(),
    status: memberStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("member_tenant_id_id").on(t.tenantId, t.id),
    unique("member_tenant_member_no").on(t.tenantId, t.memberNo),
    unique("member_tenant_nid_hash").on(t.tenantId, t.nidHash),
    foreignKey({
      name: "member_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branch.tenantId, branch.id],
    }),
    foreignKey({
      name: "member_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    index("member_tenant_phone").on(t.tenantId, t.phone),
    check("member_has_name", sql`${t.nameEn} IS NOT NULL OR ${t.nameBn} IS NOT NULL`),
    check("member_no_positive", sql`${t.memberNo} > 0`),
    check(
      "member_nid_complete",
      sql`(${t.nidCipher} IS NULL) = (${t.nidHash} IS NULL) AND (${t.nidCipher} IS NULL) = (${t.nidLast4} IS NULL)`,
    ),
  ],
);

/**
 * Who receives a member's savings if the member dies, and in what share.
 *
 * A member's nominees are saved as one set: the previous set is marked
 * removed (never deleted) and the new one inserted, so earlier nominations
 * stay on record. The active shares of a member always total 100% or 0%,
 * checked at commit by a constraint trigger (drizzle/0007).
 *
 * share_bp is in basis points: 10000 = 100%. A nominee under 18 needs a
 * guardian, named in either script.
 */
export const nominee = pgTable(
  "nominee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    memberId: uuid("member_id").notNull(),
    nameEn: text("name_en"),
    nameBn: text("name_bn"),
    relation: nomineeRelationEnum("relation").notNull(),
    phone: text("phone"),
    nidCipher: text("nid_cipher"),
    nidHash: text("nid_hash"),
    nidLast4: text("nid_last4"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    minorGuardianNameEn: text("minor_guardian_name_en"),
    minorGuardianNameBn: text("minor_guardian_name_bn"),
    shareBp: integer("share_bp").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedBy: uuid("removed_by"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "nominee_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    foreignKey({
      name: "nominee_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "nominee_removed_by_fk",
      columns: [t.tenantId, t.removedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    index("nominee_tenant_member").on(t.tenantId, t.memberId),
    check("nominee_has_name", sql`${t.nameEn} IS NOT NULL OR ${t.nameBn} IS NOT NULL`),
    check("nominee_share_range", sql`${t.shareBp} BETWEEN 1 AND 10000`),
    check("nominee_removed_together", sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`),
    check(
      "nominee_nid_complete",
      sql`(${t.nidCipher} IS NULL) = (${t.nidHash} IS NULL) AND (${t.nidCipher} IS NULL) = (${t.nidLast4} IS NULL)`,
    ),
  ],
);

/** Raw bytes in Postgres (bytea), as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * A member's photo, for KYC and the passbook. Stored in the database so it
 * shares the tenant isolation, backups and audit trail of the rest of the
 * record. The browser crops and compresses it (about 50 KB); the server
 * checks the bytes really are an image and caps the size.
 *
 * One current photo per member. Replacing or removing one marks it
 * removed, never deletes it, so earlier KYC photos stay on record.
 */
export const memberPhoto = pgTable(
  "member_photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    memberId: uuid("member_id").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** SHA-256 of the bytes; doubles as the cache-busting version in photo URLs. */
    sha256: text("sha256").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedBy: uuid("removed_by"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "member_photo_member_fk",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [member.tenantId, member.id],
    }),
    foreignKey({
      name: "member_photo_created_by_fk",
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    foreignKey({
      name: "member_photo_removed_by_fk",
      columns: [t.tenantId, t.removedBy],
      foreignColumns: [appUser.tenantId, appUser.id],
    }),
    uniqueIndex("member_photo_one_current")
      .on(t.tenantId, t.memberId)
      .where(sql`${t.removedAt} IS NULL`),
    check("member_photo_type", sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`),
    check("member_photo_size", sql`${t.byteSize} BETWEEN 1 AND 512000 AND ${t.byteSize} = octet_length(${t.bytes})`),
    check("member_photo_removed_together", sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`),
  ],
);
