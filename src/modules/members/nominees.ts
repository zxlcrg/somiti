import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, nominee, tenant } from "@/db/schema";
import { toLatinDigits } from "@/lib/digits";
import { normalizeBdPhone } from "@/lib/phone";
import { parseSharePercent } from "@/lib/shares";
import { recordAudit } from "@/modules/audit/log";
import { normalizeNid, sealNid } from "./nid";

export const NOMINEE_RELATIONS = ["spouse", "son", "daughter", "father", "mother", "brother", "sister", "other"] as const;
export type NomineeRelation = (typeof NOMINEE_RELATIONS)[number];
export const MAX_NOMINEES = 10;
/** Age below which a nominee needs a guardian. */
export const ADULT_AGE = 18;

type NomineeRow = typeof nominee.$inferSelect;
/** A nominee as screens see it: never the NID itself. */
export type NomineeView = Omit<NomineeRow, "nidCipher" | "nidHash">;

export interface NomineeInput {
  /** An existing nominee this row continues; lets the row keep its NID without retyping it. */
  id?: string;
  nameEn?: string;
  nameBn?: string;
  relation?: string;
  phone?: string;
  nid?: string;
  dateOfBirth?: string;
  minorGuardianNameEn?: string;
  minorGuardianNameBn?: string;
  /** Percent, e.g. "50" or "33.33"; Bangla digits and a trailing % are fine. */
  share?: string;
}

export type NomineeErrorCode =
  | "name_required"
  | "invalid_relation"
  | "invalid_phone"
  | "invalid_nid"
  | "invalid_date"
  | "future_date"
  | "guardian_required"
  | "invalid_share"
  | "too_long";

export type NomineeRowErrors = Partial<Record<keyof NomineeInput, NomineeErrorCode>>;

export type SaveNomineesResult =
  | { ok: true; nominees: NomineeView[]; changed: boolean }
  | {
      ok: false;
      rows: Record<number, NomineeRowErrors>;
      form?: "shares_total" | "too_many" | "member_inactive" | "not_found";
      /** Total of the shares as entered, in basis points, when form is "shares_total". */
      totalBp?: number;
    };

const viewColumns = {
  id: nominee.id,
  tenantId: nominee.tenantId,
  memberId: nominee.memberId,
  nameEn: nominee.nameEn,
  nameBn: nominee.nameBn,
  relation: nominee.relation,
  phone: nominee.phone,
  nidLast4: nominee.nidLast4,
  dateOfBirth: nominee.dateOfBirth,
  minorGuardianNameEn: nominee.minorGuardianNameEn,
  minorGuardianNameBn: nominee.minorGuardianNameBn,
  shareBp: nominee.shareBp,
  createdBy: nominee.createdBy,
  createdAt: nominee.createdAt,
  removedBy: nominee.removedBy,
  removedAt: nominee.removedAt,
};

export { equalShares, parseSharePercent } from "@/lib/shares";

function ageOn(birth: string, on: string): number {
  const [by, bm, bd] = birth.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = on.split("-").map(Number) as [number, number, number];
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}

function text(v: string | undefined, max: number): { value: string | null; tooLong: boolean } {
  const t = v?.trim() ?? "";
  return { value: t || null, tooLong: t.length > max };
}

export async function listNominees({ tx, tenantId }: TenantTx, memberId: string): Promise<NomineeView[]> {
  return tx
    .select(viewColumns)
    .from(nominee)
    .where(and(eq(nominee.tenantId, tenantId), eq(nominee.memberId, memberId), isNull(nominee.removedAt)))
    .orderBy(desc(nominee.shareBp), asc(nominee.createdAt));
}

/**
 * Replaces a member's nominees with a new set whose shares total 100%, or
 * with none. Rows that keep an existing nominee's id keep its NID when no new
 * one is typed. Saving the same set again changes nothing.
 */
export async function saveNominees(
  ctx: TenantTx,
  memberId: string,
  inputs: NomineeInput[],
  actor: { userId: string; device?: string },
): Promise<SaveNomineesResult> {
  const { tx, tenantId } = ctx;
  if (inputs.length > MAX_NOMINEES) return { ok: false, rows: {}, form: "too_many" };

  // Lock the member so two people saving nominees at once take turns.
  const [owner] = await tx
    .select({ status: member.status, businessDate: tenant.businessDate })
    .from(member)
    .innerJoin(tenant, eq(tenant.id, member.tenantId))
    .where(and(eq(member.tenantId, tenantId), eq(member.id, memberId)))
    .for("update", { of: member });
  if (!owner) return { ok: false, rows: {}, form: "not_found" };
  if (owner.status !== "active") return { ok: false, rows: {}, form: "member_inactive" };

  const current = await tx
    .select()
    .from(nominee)
    .where(and(eq(nominee.tenantId, tenantId), eq(nominee.memberId, memberId), isNull(nominee.removedAt)));
  const currentById = new Map(current.map((n) => [n.id, n]));

  const rows: Record<number, NomineeRowErrors> = {};
  const prepared: (typeof nominee.$inferInsert)[] = [];
  let totalBp = 0;

  inputs.forEach((input, i) => {
    const errors: NomineeRowErrors = {};
    const nameEn = text(input.nameEn, 120);
    const nameBn = text(input.nameBn, 120);
    const guardianEn = text(input.minorGuardianNameEn, 120);
    const guardianBn = text(input.minorGuardianNameBn, 120);
    if (!nameEn.value && !nameBn.value) errors.nameEn = "name_required";
    if (nameEn.tooLong) errors.nameEn = "too_long";
    if (nameBn.tooLong) errors.nameBn = "too_long";

    const relation = NOMINEE_RELATIONS.find((r) => r === input.relation);
    if (!relation) errors.relation = "invalid_relation";

    let phone: string | null = null;
    if (input.phone?.trim()) {
      phone = normalizeBdPhone(input.phone);
      if (!phone) errors.phone = "invalid_phone";
    }

    let sealed: Pick<NomineeRow, "nidCipher" | "nidHash" | "nidLast4"> = { nidCipher: null, nidHash: null, nidLast4: null };
    if (input.nid?.trim()) {
      const nid = normalizeNid(input.nid);
      if (nid) sealed = sealNid(tenantId, nid);
      else errors.nid = "invalid_nid";
    } else if (input.id && currentById.has(input.id)) {
      const kept = currentById.get(input.id)!;
      sealed = { nidCipher: kept.nidCipher, nidHash: kept.nidHash, nidLast4: kept.nidLast4 };
    }

    let dateOfBirth: string | null = null;
    if (input.dateOfBirth?.trim()) {
      const d = toLatinDigits(input.dateOfBirth.trim());
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
      if (!valid) errors.dateOfBirth = "invalid_date";
      else if (d > owner.businessDate) errors.dateOfBirth = "future_date";
      else dateOfBirth = d;
    }
    const minor = dateOfBirth !== null && ageOn(dateOfBirth, owner.businessDate) < ADULT_AGE;
    if (minor && !guardianEn.value && !guardianBn.value) errors.minorGuardianNameEn = "guardian_required";

    const shareBp = parseSharePercent(input.share ?? "");
    if (shareBp === null) errors.share = "invalid_share";
    else totalBp += shareBp;

    if (Object.keys(errors).length) {
      rows[i] = errors;
      return;
    }
    prepared.push({
      tenantId,
      memberId,
      nameEn: nameEn.value,
      nameBn: nameBn.value,
      relation: relation!,
      phone,
      ...sealed,
      dateOfBirth,
      // A guardian only means something for a minor.
      minorGuardianNameEn: minor ? guardianEn.value : null,
      minorGuardianNameBn: minor ? guardianBn.value : null,
      shareBp: shareBp!,
      createdBy: actor.userId,
    });
  });

  if (Object.keys(rows).length) return { ok: false, rows };
  if (prepared.length > 0 && totalBp !== 10_000) return { ok: false, rows: {}, form: "shares_total", totalBp };

  const key = (n: Pick<NomineeRow, "nameEn" | "nameBn" | "relation" | "phone" | "nidHash" | "dateOfBirth" | "minorGuardianNameEn" | "minorGuardianNameBn" | "shareBp">) =>
    JSON.stringify([n.nameEn, n.nameBn, n.relation, n.phone, n.nidHash, n.dateOfBirth, n.minorGuardianNameEn, n.minorGuardianNameBn, n.shareBp]);
  const same =
    current.length === prepared.length &&
    current.map((n) => key(n)).sort().join("|") === prepared.map((n) => key(n as NomineeRow)).sort().join("|");
  if (same) return { ok: true, nominees: await listNominees(ctx, memberId), changed: false };

  if (current.length) {
    await tx
      .update(nominee)
      .set({ removedAt: sql`now()`, removedBy: actor.userId })
      .where(and(eq(nominee.tenantId, tenantId), eq(nominee.memberId, memberId), isNull(nominee.removedAt)));
  }
  if (prepared.length) await tx.insert(nominee).values(prepared);

  const summary = (list: { nameEn: string | null; nameBn: string | null; relation: string; shareBp: number }[]) =>
    list.map((n) => ({ nameEn: n.nameEn, nameBn: n.nameBn, relation: n.relation, shareBp: n.shareBp }));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "member.nominees",
    entityType: "member",
    entityId: memberId,
    before: summary(current),
    after: summary(prepared as NomineeRow[]),
    device: actor.device,
  });
  return { ok: true, nominees: await listNominees(ctx, memberId), changed: true };
}
