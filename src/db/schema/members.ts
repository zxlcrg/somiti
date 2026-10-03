import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { appUser, branch, localeEnum, tenant } from "./tenancy";

export const memberStatusEnum = pgEnum("member_status", ["active", "exited", "deceased"]);
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
