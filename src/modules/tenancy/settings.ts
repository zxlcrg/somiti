import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { appUser, branch, tenant, userRole } from "@/db/schema";
import { isLocale, type Locale } from "@/i18n/config";
import { parseTaka } from "@/lib/money";
import { normalizeBdPhone } from "@/lib/phone";
import { recordAudit } from "@/modules/audit/log";

/*
 * Somiti settings and the staff who sign in (architecture doc, "Security
 * and controls": the admin does tenant setup, users and settings, and
 * posts no money). Every change goes to the audit log.
 *
 * A somiti must never lock itself out: the admin can't take away their own
 * admin role or deactivate themselves, and the last active admin stays.
 */

/** Roles an admin can give staff. "member" is for the member portal, which comes later. */
export const STAFF_ROLES = ["admin", "president", "secretary", "cashier", "field_collector"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** ৳1,00,000: far above any bylaw's share price, so a typo can't go through. */
const MAX_SHARE_PRICE = 1_00_000_00n;
const MAX_NAME = 120;

export function canManageSettings(roles: readonly string[]): boolean {
  return roles.includes("admin");
}

// ---------- Somiti ----------

export interface SomitiSettings {
  slug: string;
  nameEn: string | null;
  nameBn: string | null;
  defaultLocale: Locale;
  sharePrice: bigint;
  businessDate: string;
  fiscalYearStartMonth: number;
}

export async function getSomitiSettings({ tx, tenantId }: TenantTx): Promise<SomitiSettings> {
  const [row] = await tx
    .select({
      slug: tenant.slug,
      nameEn: tenant.nameEn,
      nameBn: tenant.nameBn,
      defaultLocale: tenant.defaultLocale,
      sharePrice: tenant.sharePrice,
      businessDate: tenant.businessDate,
      fiscalYearStartMonth: tenant.fiscalYearStartMonth,
    })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!row) throw new Error("Unknown somiti");
  return row;
}

export interface SomitiForm {
  nameEn?: string;
  nameBn?: string;
  defaultLocale?: string;
  /** Typed taka; Bangla digits are fine. */
  sharePrice?: string;
}

export type SomitiError = "name_required" | "too_long" | "invalid_locale" | "invalid_price" | "price_too_high";
export type SomitiErrors = Partial<Record<keyof SomitiForm, SomitiError>>;

export async function updateSomitiSettings(
  ctx: TenantTx,
  form: SomitiForm,
  actor: { userId: string; device?: string },
): Promise<{ ok: true; changed: boolean } | { ok: false; errors: SomitiErrors }> {
  const errors: SomitiErrors = {};
  const nameEn = form.nameEn?.trim() || null;
  const nameBn = form.nameBn?.trim() || null;
  if (!nameEn && !nameBn) errors.nameEn = "name_required";
  if ((nameEn?.length ?? 0) > MAX_NAME) errors.nameEn = "too_long";
  if ((nameBn?.length ?? 0) > MAX_NAME) errors.nameBn = "too_long";
  const defaultLocale = form.defaultLocale;
  if (!isLocale(defaultLocale)) errors.defaultLocale = "invalid_locale";
  const sharePrice = parseTaka(form.sharePrice ?? "");
  if (sharePrice === null || sharePrice <= 0n) errors.sharePrice = "invalid_price";
  else if (sharePrice > MAX_SHARE_PRICE) errors.sharePrice = "price_too_high";
  if (Object.keys(errors).length) return { ok: false, errors };

  const before = await getSomitiSettings(ctx);
  const after = { nameEn, nameBn, defaultLocale: defaultLocale as Locale, sharePrice: sharePrice! };
  const changed =
    before.nameEn !== after.nameEn ||
    before.nameBn !== after.nameBn ||
    before.defaultLocale !== after.defaultLocale ||
    before.sharePrice !== after.sharePrice;
  if (!changed) return { ok: true, changed: false };

  await ctx.tx.update(tenant).set(after).where(eq(tenant.id, ctx.tenantId));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "settings.somiti.update",
    entityType: "tenant",
    entityId: ctx.tenantId,
    before: { nameEn: before.nameEn, nameBn: before.nameBn, defaultLocale: before.defaultLocale, sharePrice: before.sharePrice },
    after,
    device: actor.device,
  });
  return { ok: true, changed: true };
}

// ---------- Staff ----------

export interface StaffView {
  id: string;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  isActive: boolean;
  roles: StaffRole[];
  createdAt: Date;
}

export async function listStaff({ tx, tenantId }: TenantTx): Promise<StaffView[]> {
  const users = await tx
    .select({
      id: appUser.id,
      nameEn: appUser.nameEn,
      nameBn: appUser.nameBn,
      phone: appUser.phone,
      isActive: appUser.isActive,
      createdAt: appUser.createdAt,
    })
    .from(appUser)
    .where(eq(appUser.tenantId, tenantId))
    .orderBy(asc(appUser.createdAt));
  const roles = await tx
    .select({ userId: userRole.userId, role: userRole.role })
    .from(userRole)
    .where(eq(userRole.tenantId, tenantId));
  const byUser = new Map<string, StaffRole[]>();
  for (const r of roles) {
    if (!(STAFF_ROLES as readonly string[]).includes(r.role)) continue;
    byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.role as StaffRole]);
  }
  return users.map((u) => ({
    ...u,
    roles: STAFF_ROLES.filter((role) => byUser.get(u.id)?.includes(role)),
  }));
}

export interface StaffForm {
  nameEn?: string;
  nameBn?: string;
  phone?: string;
  roles?: string[];
}

export type StaffError =
  | "name_required"
  | "too_long"
  | "invalid_phone"
  | "duplicate_phone"
  | "role_required"
  | "invalid_role"
  | "own_admin"
  | "last_admin"
  | "self_deactivate"
  | "not_found";

export type StaffErrors = Partial<Record<keyof StaffForm | "form", StaffError>>;

export type StaffResult = { ok: true; userId: string; changed: boolean } | { ok: false; errors: StaffErrors };

function checkStaffForm(form: StaffForm): { ok: true; value: { nameEn: string | null; nameBn: string | null; phone: string; roles: StaffRole[] } } | { ok: false; errors: StaffErrors } {
  const errors: StaffErrors = {};
  const nameEn = form.nameEn?.trim() || null;
  const nameBn = form.nameBn?.trim() || null;
  if (!nameEn && !nameBn) errors.nameEn = "name_required";
  if ((nameEn?.length ?? 0) > MAX_NAME) errors.nameEn = "too_long";
  if ((nameBn?.length ?? 0) > MAX_NAME) errors.nameBn = "too_long";
  const phone = normalizeBdPhone(form.phone ?? "");
  if (!phone) errors.phone = "invalid_phone";
  const roles = [...new Set(form.roles ?? [])];
  if (roles.length === 0) errors.roles = "role_required";
  else if (roles.some((r) => !(STAFF_ROLES as readonly string[]).includes(r))) errors.roles = "invalid_role";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { nameEn, nameBn, phone: phone!, roles: STAFF_ROLES.filter((r) => roles.includes(r)) } };
}

/** Staff changes take turns, so two admins can't each remove the other's admin role at once. */
async function lockStaff({ tx, tenantId }: TenantTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`staff:${tenantId}`}))`);
}

async function phoneTaken({ tx, tenantId }: TenantTx, phone: string, exceptUserId?: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(and(eq(appUser.tenantId, tenantId), eq(appUser.phone, phone)));
  return !!row && row.id !== exceptUserId;
}

/** Active admins other than this user. */
async function otherActiveAdmins({ tx, tenantId }: TenantTx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${appUser.id})::int` })
    .from(appUser)
    .innerJoin(userRole, and(eq(userRole.tenantId, appUser.tenantId), eq(userRole.userId, appUser.id)))
    .where(and(eq(appUser.tenantId, tenantId), eq(appUser.isActive, true), eq(userRole.role, "admin"), sql`${appUser.id} <> ${userId}`));
  return row?.n ?? 0;
}

/** Adds someone who can sign in, with their roles, at the somiti's first branch. */
export async function addStaff(ctx: TenantTx, form: StaffForm, actor: { userId: string; device?: string }): Promise<StaffResult> {
  const checked = checkStaffForm(form);
  if (!checked.ok) return checked;
  const { nameEn, nameBn, phone, roles } = checked.value;
  await lockStaff(ctx);
  if (await phoneTaken(ctx, phone)) return { ok: false, errors: { phone: "duplicate_phone" } };

  const { tx, tenantId } = ctx;
  const [home] = await tx.select({ id: branch.id }).from(branch).where(eq(branch.tenantId, tenantId)).orderBy(asc(branch.createdAt)).limit(1);
  const [user] = await tx
    .insert(appUser)
    .values({ tenantId, branchId: home?.id, nameEn, nameBn, phone })
    .returning({ id: appUser.id });
  await tx.insert(userRole).values(roles.map((role) => ({ tenantId, userId: user!.id, role })));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "settings.staff.add",
    entityType: "app_user",
    entityId: user!.id,
    after: { nameEn, nameBn, phone, roles },
    device: actor.device,
  });
  return { ok: true, userId: user!.id, changed: true };
}

/** Changes someone's name, phone or roles. */
export async function updateStaff(
  ctx: TenantTx,
  userId: string,
  form: StaffForm,
  actor: { userId: string; device?: string },
): Promise<StaffResult> {
  const checked = checkStaffForm(form);
  if (!checked.ok) return checked;
  const { nameEn, nameBn, phone, roles } = checked.value;
  await lockStaff(ctx);
  const before = (await listStaff(ctx)).find((s) => s.id === userId);
  if (!before) return { ok: false, errors: { form: "not_found" } };
  if (await phoneTaken(ctx, phone, userId)) return { ok: false, errors: { phone: "duplicate_phone" } };

  const losingAdmin = before.roles.includes("admin") && !roles.includes("admin");
  if (losingAdmin && userId === actor.userId) return { ok: false, errors: { roles: "own_admin" } };
  if (losingAdmin && before.isActive && (await otherActiveAdmins(ctx, userId)) === 0) return { ok: false, errors: { roles: "last_admin" } };

  const changed =
    before.nameEn !== nameEn || before.nameBn !== nameBn || before.phone !== phone || before.roles.join() !== roles.join();
  if (!changed) return { ok: true, userId, changed: false };

  const { tx, tenantId } = ctx;
  await tx.update(appUser).set({ nameEn, nameBn, phone }).where(and(eq(appUser.tenantId, tenantId), eq(appUser.id, userId)));
  const removed = before.roles.filter((r) => !roles.includes(r));
  const added = roles.filter((r) => !before.roles.includes(r));
  if (removed.length) {
    await tx
      .delete(userRole)
      .where(and(eq(userRole.tenantId, tenantId), eq(userRole.userId, userId), inArray(userRole.role, removed)));
  }
  if (added.length) await tx.insert(userRole).values(added.map((role) => ({ tenantId, userId, role })));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "settings.staff.update",
    entityType: "app_user",
    entityId: userId,
    before: { nameEn: before.nameEn, nameBn: before.nameBn, phone: before.phone, roles: before.roles },
    after: { nameEn, nameBn, phone, roles },
    device: actor.device,
  });
  return { ok: true, userId, changed: true };
}

/**
 * Switches someone's access off or back on. A deactivated person's
 * sessions stop working at once (sign-in checks is_active); their past
 * work stays theirs in the books and the audit log.
 */
export async function setStaffActive(
  ctx: TenantTx,
  userId: string,
  active: boolean,
  actor: { userId: string; device?: string },
): Promise<StaffResult> {
  await lockStaff(ctx);
  const before = (await listStaff(ctx)).find((s) => s.id === userId);
  if (!before) return { ok: false, errors: { form: "not_found" } };
  if (before.isActive === active) return { ok: true, userId, changed: false };
  if (!active && userId === actor.userId) return { ok: false, errors: { form: "self_deactivate" } };
  if (!active && before.roles.includes("admin") && (await otherActiveAdmins(ctx, userId)) === 0) {
    return { ok: false, errors: { form: "last_admin" } };
  }
  await ctx.tx.update(appUser).set({ isActive: active }).where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.id, userId)));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: active ? "settings.staff.reactivate" : "settings.staff.deactivate",
    entityType: "app_user",
    entityId: userId,
    device: actor.device,
  });
  return { ok: true, userId, changed: true };
}
