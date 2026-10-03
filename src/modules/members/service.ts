import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { branch, member, tenant } from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { toLatinDigits } from "@/lib/digits";
import { recordAudit } from "@/modules/audit/log";
import { nidLookupHash, sealNid } from "./nid";
import { validateAdmission, type AdmitMemberInput, type MemberFieldErrors } from "./validation";

export type MemberRow = typeof member.$inferSelect;
/** A member as screens see it: never the NID itself, only its last four digits. */
export type MemberView = Omit<MemberRow, "nidCipher" | "nidHash">;
export type MemberStatus = MemberRow["status"];

function view(row: MemberRow): MemberView {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { nidCipher, nidHash, ...rest } = row;
  return rest;
}

const viewColumns = {
  id: member.id,
  tenantId: member.tenantId,
  branchId: member.branchId,
  memberNo: member.memberNo,
  nameEn: member.nameEn,
  nameBn: member.nameBn,
  guardianRelation: member.guardianRelation,
  guardianNameEn: member.guardianNameEn,
  guardianNameBn: member.guardianNameBn,
  phone: member.phone,
  nidLast4: member.nidLast4,
  dateOfBirth: member.dateOfBirth,
  address: member.address,
  commLocale: member.commLocale,
  admissionDate: member.admissionDate,
  status: member.status,
  createdBy: member.createdBy,
  createdAt: member.createdAt,
};

export type AdmitResult = { ok: true; member: MemberView } | { ok: false; errors: MemberFieldErrors };

/**
 * Admits a member: gives the next member number and records the admission
 * in the audit log (without the NID). Admission can't be dated after the
 * somiti's business date.
 */
export async function admitMember(
  ctx: TenantTx,
  input: AdmitMemberInput,
  actor: { userId: string; device?: string },
): Promise<AdmitResult> {
  const { tx, tenantId } = ctx;
  const [somiti] = await tx
    .select({ businessDate: tenant.businessDate })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!somiti) throw new Error("Unknown somiti");

  const parsed = validateAdmission({ ...input, admissionDate: input.admissionDate || somiti.businessDate });
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  const admissionDate = data.admissionDate!;
  if (admissionDate > somiti.businessDate) {
    return { ok: false, errors: { admissionDate: "admission_after_business_date" } };
  }

  if (data.nid) {
    const [dup] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.tenantId, tenantId), eq(member.nidHash, nidLookupHash(tenantId, data.nid))));
    if (dup) return { ok: false, errors: { nid: "duplicate_nid" } };
  }

  const [home] = data.branchId
    ? await tx.select({ id: branch.id }).from(branch).where(and(eq(branch.tenantId, tenantId), eq(branch.id, data.branchId)))
    : await tx.select({ id: branch.id }).from(branch).where(eq(branch.tenantId, tenantId)).orderBy(asc(branch.createdAt)).limit(1);
  if (!home) return { ok: false, errors: { branchId: "invalid" } };

  // Member numbers are gap-free per somiti; admissions take turns for the next one.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`member_no:${tenantId}`}))`);
  const [last] = await tx
    .select({ n: sql<number>`coalesce(max(${member.memberNo}), 0)` })
    .from(member)
    .where(eq(member.tenantId, tenantId));

  const [row] = await tx
    .insert(member)
    .values({
      tenantId,
      branchId: home.id,
      memberNo: Number(last?.n ?? 0) + 1,
      nameEn: data.nameEn,
      nameBn: data.nameBn,
      guardianRelation: data.guardianNameEn || data.guardianNameBn ? (data.guardianRelation ?? "father") : null,
      guardianNameEn: data.guardianNameEn,
      guardianNameBn: data.guardianNameBn,
      phone: data.phone,
      ...(data.nid ? sealNid(tenantId, data.nid) : {}),
      dateOfBirth: data.dateOfBirth,
      address: data.address,
      commLocale: data.commLocale,
      admissionDate,
      createdBy: actor.userId,
    })
    .returning();

  const admitted = view(row!);
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "member.admit",
    entityType: "member",
    entityId: admitted.id,
    after: { ...admitted, nidLast4: admitted.nidLast4 ? "set" : null },
    device: actor.device,
  });
  return { ok: true, member: admitted };
}

export interface MemberQuery {
  /** Part of a name in either script, a member number or part of a phone number. */
  q?: string;
  status?: MemberStatus;
  /** "number" (newest first) or "name", sorted in the reader's language. */
  sort?: "number" | "name";
  locale?: Locale;
  limit?: number;
  offset?: number;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listMembers(
  { tx, tenantId }: TenantTx,
  query: MemberQuery = {},
): Promise<{ members: MemberView[]; total: number }> {
  const filters: SQL[] = [eq(member.tenantId, tenantId)];
  if (query.status) filters.push(eq(member.status, query.status));

  const q = toLatinDigits(query.q ?? "").trim();
  if (q) {
    const digits = q.replace(/[\s+-]/g, "");
    const pattern = `%${escapeLike(q)}%`;
    const matches: SQL[] = [ilike(member.nameEn, pattern), ilike(member.nameBn, pattern)];
    if (/^\d+$/.test(digits)) {
      if (digits.length <= 9) matches.push(eq(member.memberNo, Number(digits)));
      if (digits.length >= 3) matches.push(sql`${member.phone} like ${`%${digits.replace(/^0/, "")}%`}`);
    }
    filters.push(or(...matches)!);
  }

  const where = and(...filters);
  const order =
    query.sort === "name"
      ? query.locale === "bn"
        ? [sql`${member.nameBn} asc nulls last`, sql`${member.nameEn} asc nulls last`, asc(member.memberNo)]
        : [sql`${member.nameEn} asc nulls last`, sql`${member.nameBn} asc nulls last`, asc(member.memberNo)]
      : [desc(member.memberNo)];

  const [rows, [totals]] = await Promise.all([
    tx
      .select(viewColumns)
      .from(member)
      .where(where)
      .orderBy(...order)
      .limit(Math.min(query.limit ?? 50, 200))
      .offset(query.offset ?? 0),
    tx.select({ n: count() }).from(member).where(where),
  ]);
  return { members: rows, total: totals?.n ?? 0 };
}

export interface MemberStats {
  total: number;
  active: number;
  /** Admitted in the business date's month. */
  admittedThisMonth: number;
}

export async function memberStats({ tx, tenantId }: TenantTx): Promise<MemberStats> {
  const [row] = await tx
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${member.status} = 'active')::int`,
      admittedThisMonth: sql<number>`count(*) filter (where date_trunc('month', ${member.admissionDate}) = date_trunc('month', ${tenant.businessDate}))::int`,
    })
    .from(member)
    .innerJoin(tenant, eq(tenant.id, member.tenantId))
    .where(eq(member.tenantId, tenantId));
  return { total: row?.total ?? 0, active: row?.active ?? 0, admittedThisMonth: row?.admittedThisMonth ?? 0 };
}

/** The number the next admission will probably get; for display only, admitMember decides. */
export async function nextMemberNo({ tx, tenantId }: TenantTx): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${member.memberNo}), 0) + 1` })
    .from(member)
    .where(eq(member.tenantId, tenantId));
  return Number(row?.n ?? 1);
}

export async function getMember({ tx, tenantId }: TenantTx, id: string): Promise<MemberView | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx
    .select(viewColumns)
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, id)));
  return row ?? null;
}
