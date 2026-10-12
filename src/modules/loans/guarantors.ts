import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { TenantTx } from "@/db/client";
import { loan, loanGuarantor, loanProduct, member } from "@/db/schema";
import { photoVersion } from "@/modules/members/photos";

/** Loans that still need their guarantors: applied for, approved or running. */
export const GUARANTEED_STATUSES = ["applied", "approved", "disbursed"] as const;

export interface GuarantorView {
  memberId: string;
  memberNo: number;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  status: string;
  photoVersion: string | null;
  position: number;
}

/** The members standing guarantor for one loan, in the order they were named. */
export async function loanGuarantors({ tx, tenantId }: TenantTx, loanId: string): Promise<GuarantorView[]> {
  const rows = await tx
    .select({
      memberId: member.id,
      memberNo: member.memberNo,
      nameEn: member.nameEn,
      nameBn: member.nameBn,
      phone: member.phone,
      status: member.status,
      photoSha: sql<string | null>`(select p.sha256 from member_photo p where p.tenant_id = ${member.tenantId} and p.member_id = ${member.id} and p.removed_at is null order by p.created_at desc limit 1)`,
      position: loanGuarantor.position,
    })
    .from(loanGuarantor)
    .innerJoin(member, and(eq(member.tenantId, loanGuarantor.tenantId), eq(member.id, loanGuarantor.memberId)))
    .where(and(eq(loanGuarantor.tenantId, tenantId), eq(loanGuarantor.loanId, loanId)))
    .orderBy(asc(loanGuarantor.position));
  return rows.map(({ photoSha, ...r }) => ({ ...r, photoVersion: photoSha ? photoVersion(photoSha) : null }));
}

export interface GuaranteeView {
  loanId: string;
  loanNo: number;
  status: (typeof GUARANTEED_STATUSES)[number];
  productCode: string;
  principal: bigint;
  /** Principal still owed; the full principal until the loan is paid out. */
  outstanding: bigint;
  borrower: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null };
}

const borrower = alias(member, "borrower");

/** Loans a member stands guarantor for that are not yet finished. */
export async function memberGuarantees({ tx, tenantId }: TenantTx, memberId: string): Promise<GuaranteeView[]> {
  const rows = await tx
    .select({
      loanId: loan.id,
      loanNo: loan.loanNo,
      status: loan.status,
      productCode: loanProduct.code,
      principal: loan.principal,
      repaid: sql<string>`(select coalesce(sum(p.principal), 0) from loan_repayment p where p.tenant_id = ${loan.tenantId} and p.loan_id = ${loan.id})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
      borrowerId: borrower.id,
      borrowerNo: borrower.memberNo,
      borrowerEn: borrower.nameEn,
      borrowerBn: borrower.nameBn,
    })
    .from(loanGuarantor)
    .innerJoin(loan, and(eq(loan.tenantId, loanGuarantor.tenantId), eq(loan.id, loanGuarantor.loanId)))
    .innerJoin(loanProduct, and(eq(loanProduct.tenantId, loan.tenantId), eq(loanProduct.id, loan.productId)))
    .innerJoin(borrower, and(eq(borrower.tenantId, loan.tenantId), eq(borrower.id, loan.memberId)))
    .where(and(eq(loanGuarantor.tenantId, tenantId), eq(loanGuarantor.memberId, memberId), inArray(loan.status, [...GUARANTEED_STATUSES])))
    .orderBy(asc(loan.loanNo));
  return rows.map((r) => ({
    loanId: r.loanId,
    loanNo: r.loanNo,
    status: r.status as GuaranteeView["status"],
    productCode: r.productCode,
    principal: r.principal,
    outstanding: r.principal - (r.repaid as unknown as bigint),
    borrower: { id: r.borrowerId, memberNo: r.borrowerNo, nameEn: r.borrowerEn, nameBn: r.borrowerBn },
  }));
}

export interface GuarantorCandidate {
  id: string;
  memberNo: number;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  photoVersion: string | null;
  /** Unfinished loans they already stand guarantor for. */
  guarantees: number;
}

/** Every active member who could stand guarantor for this borrower, by member number. */
export async function guarantorCandidates({ tx, tenantId }: TenantTx, borrowerId: string): Promise<GuarantorCandidate[]> {
  const rows = await tx
    .select({
      id: member.id,
      memberNo: member.memberNo,
      nameEn: member.nameEn,
      nameBn: member.nameBn,
      phone: member.phone,
      photoSha: sql<string | null>`(select p.sha256 from member_photo p where p.tenant_id = member.tenant_id and p.member_id = member.id and p.removed_at is null order by p.created_at desc limit 1)`,
      guarantees: sql<number>`(select count(*)::int from loan_guarantor g join loan l on l.tenant_id = g.tenant_id and l.id = g.loan_id
        where g.tenant_id = member.tenant_id and g.member_id = member.id and l.status in ('applied', 'approved', 'disbursed'))`,
    })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.status, "active"), ne(member.id, borrowerId)))
    .orderBy(asc(member.memberNo));
  return rows.map(({ photoSha, ...r }) => ({ ...r, photoVersion: photoSha ? photoVersion(photoSha) : null }));
}
