import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { appUser, loan, loanInstallment, loanProduct, loanReschedule, loanRescheduleLine, tenant } from "@/db/schema";
import { addMonths } from "@/lib/dates";
import { toLatinDigits } from "@/lib/digits";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { queueMemberSms } from "@/modules/messages/outbox";
import { loanRescheduleText } from "@/modules/messages/texts";
import { outstanding } from "./allocate";
import { scheduleState } from "./loans";
import { MAX_INSTALLMENTS } from "./products";
import { rescheduleRows } from "./schedule";

/*
 * Rescheduling a running loan (architecture doc, M3): a member who has
 * fallen behind gets a new schedule for everything still owed. Nothing is
 * posted, because no money moves and charges are income only when paid. What
 * was left on each old installment is recorded as moved, and the same total
 * (plus any extra charge agreed for the longer term) is written again as new
 * installments that carry on the loan's numbering. The old installments stay
 * as they were written, marked rescheduled, so the record of what was agreed
 * first is never lost.
 */

export interface RescheduleForm {
  loanId: string;
  installments: string;
  /** ISO date of the first new installment; after today and within a year. */
  firstDueOn: string;
  /** Typed taka; blank for none. */
  extraCharge?: string;
  reason: string;
}

export type RescheduleError =
  | "required"
  | "invalid_installments"
  | "invalid_date"
  | "date_past"
  | "date_too_far"
  | "invalid_amount"
  | "reason_length"
  | "too_many_installments"
  | "not_found"
  | "not_running"
  | "nothing_owed";

export type RescheduleErrors = Partial<Record<"installments" | "firstDueOn" | "extraCharge" | "reason" | "form", RescheduleError>>;

export interface RescheduleView {
  id: string;
  no: number;
  businessDate: string;
  principal: bigint;
  interest: bigint;
  extraCharge: bigint;
  installments: number;
  firstDueOn: string;
  reason: string;
  createdBy: { nameEn: string | null; nameBn: string | null };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function rescheduleLoan(
  ctx: TenantTx,
  form: RescheduleForm,
  actor: { userId: string; device?: string },
): Promise<{ ok: true; reschedule: RescheduleView } | { ok: false; errors: RescheduleErrors }> {
  const { tx, tenantId } = ctx;
  const errors: RescheduleErrors = {};
  const nText = toLatinDigits(form.installments.trim());
  const n = /^\d{1,3}$/.test(nText) ? Number(nText) : NaN;
  if (!nText) errors.installments = "required";
  else if (!(n >= 1 && n <= MAX_INSTALLMENTS)) errors.installments = "invalid_installments";
  const [day] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const today = day!.d;
  const first = form.firstDueOn.trim();
  if (!first) errors.firstDueOn = "required";
  else if (!ISO.test(first) || Number.isNaN(Date.parse(`${first}T00:00:00Z`))) errors.firstDueOn = "invalid_date";
  else if (first <= today) errors.firstDueOn = "date_past";
  else if (first > addMonths(today, 12)) errors.firstDueOn = "date_too_far";
  const extra = form.extraCharge?.trim() ? parseTaka(form.extraCharge) : 0n;
  if (extra === null || extra < 0n || extra > 1_00_00_000_00n) errors.extraCharge = "invalid_amount";
  const reason = form.reason.trim();
  if (reason.length < 3 || reason.length > 300) errors.reason = "reason_length";
  if (Object.keys(errors).length) return { ok: false, errors };

  // One change to a loan at a time: repayments take the same lock.
  const [l] = await tx
    .select()
    .from(loan)
    .where(and(eq(loan.tenantId, tenantId), eq(loan.id, form.loanId)))
    .for("update");
  if (!l) return { ok: false, errors: { form: "not_found" } };
  if (l.status !== "disbursed") return { ok: false, errors: { form: "not_running" } };

  const rows = await scheduleState(ctx, l.id);
  const owed = outstanding(rows);
  if (owed.total === 0n) return { ok: false, errors: { form: "nothing_owed" } };
  const fresh = rescheduleRows({ principal: owed.principal, interest: owed.interest + extra!, installments: n, frequency: l.frequency, firstDueOn: first });
  if (!fresh) return { ok: false, errors: { installments: "too_many_installments" } };

  const [prev] = await tx
    .select({ no: sql<number>`coalesce(max(${loanReschedule.no}), 0)::int` })
    .from(loanReschedule)
    .where(and(eq(loanReschedule.tenantId, tenantId), eq(loanReschedule.loanId, l.id)));
  const no = (prev?.no ?? 0) + 1;
  const lastSeq = rows.reduce((m, r) => (r.seq > m ? r.seq : m), 0);
  const [rec] = await tx
    .insert(loanReschedule)
    .values({
      tenantId,
      loanId: l.id,
      no,
      businessDate: today,
      principal: owed.principal,
      interest: owed.interest,
      extraCharge: extra!,
      installments: n,
      firstDueOn: first,
      reason,
      createdBy: actor.userId,
    })
    .returning({ id: loanReschedule.id });
  const moved = rows
    .map((r) => ({
      seq: r.seq,
      principal: r.principal - r.paidPrincipal - (r.movedPrincipal ?? 0n),
      interest: r.interest - r.paidInterest - (r.rebated ?? 0n) - (r.movedInterest ?? 0n),
    }))
    .filter((x) => x.principal + x.interest > 0n);
  await tx.insert(loanRescheduleLine).values(moved.map((x) => ({ tenantId, rescheduleId: rec!.id, loanId: l.id, ...x })));
  await tx.insert(loanInstallment).values(fresh.map((r) => ({ tenantId, loanId: l.id, seq: lastSeq + r.seq, dueOn: r.dueOn, principal: r.principal, interest: r.interest, scheduleNo: no })));

  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "loan.reschedule",
    entityType: "loan",
    entityId: l.id,
    before: { installmentsLeft: moved.map((x) => x.seq), principal: owed.principal.toString(), interest: owed.interest.toString() },
    after: { no, installments: n, firstDueOn: first, extraCharge: extra!.toString(), reason, seqs: [lastSeq + 1, lastSeq + n] },
    device: actor.device,
  });
  const [owner] = await tx
    .select({ code: loanProduct.code })
    .from(loanProduct)
    .where(and(eq(loanProduct.tenantId, tenantId), eq(loanProduct.id, l.productId)));
  await queueMemberSms(ctx, {
    memberId: l.memberId,
    kind: "loan_reschedule",
    refId: rec!.id,
    text: (locale, somiti) =>
      loanRescheduleText(
        { somiti, productCode: owner!.code, loanNo: l.loanNo, installments: n, installment: fresh[0]!.principal + fresh[0]!.interest, firstDueOn: first },
        locale,
      ),
  });
  const [view] = await listReschedules(ctx, l.id, rec!.id);
  return { ok: true, reschedule: view! };
}

/** A loan's reschedulings, oldest first. */
export async function listReschedules({ tx, tenantId }: TenantTx, loanId: string, id?: string): Promise<RescheduleView[]> {
  const rows = await tx
    .select({
      id: loanReschedule.id,
      no: loanReschedule.no,
      businessDate: loanReschedule.businessDate,
      principal: loanReschedule.principal,
      interest: loanReschedule.interest,
      extraCharge: loanReschedule.extraCharge,
      installments: loanReschedule.installments,
      firstDueOn: loanReschedule.firstDueOn,
      reason: loanReschedule.reason,
      byEn: appUser.nameEn,
      byBn: appUser.nameBn,
    })
    .from(loanReschedule)
    .innerJoin(appUser, and(eq(appUser.tenantId, loanReschedule.tenantId), eq(appUser.id, loanReschedule.createdBy)))
    .where(and(eq(loanReschedule.tenantId, tenantId), eq(loanReschedule.loanId, loanId), id ? eq(loanReschedule.id, id) : undefined))
    .orderBy(asc(loanReschedule.no));
  return rows.map(({ byEn, byBn, ...r }) => ({ ...r, createdBy: { nameEn: byEn, nameBn: byBn } }));
}
