import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { appUser, idempotencyKey, loan, loanFine, loanProduct, loanRepayment, loanRepaymentLine, member, tenant } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, postEntry } from "@/modules/ledger";
import { queueMemberSms } from "@/modules/messages/outbox";
import { loanRepaymentText } from "@/modules/messages/texts";
import { allocate, lateFineFor, outstanding } from "./allocate";
import { finedSeqs, PAYMENT_METHODS, scheduleState, type LoanPaymentMethod } from "./loans";

/*
 * Collecting a repayment (architecture doc, "Collection"): Dr the cash, bank
 * or wallet it came into, or Cash with collector for a field round; Cr Loans
 * receivable for the principal part and Cr Service charge / interest income
 * for the rest, plus Cr Fine income for any late fine taken on top.
 * Interest counts as income when the cash arrives (cash basis).
 * The split follows the loan's allocation order, oldest installment first
 * (see allocate.ts). The last taka owed closes the loan.
 */

export type RepaymentChannel = "office" | "collector";

const ACCOUNT_FOR: Record<LoanPaymentMethod, "cash_in_hand" | "bank" | "mobile_wallet"> = {
  cash: "cash_in_hand",
  bank: "bank",
  mobile_wallet: "mobile_wallet",
};

export interface RepaymentInput {
  loanId: string;
  /** Typed taka; Bangla digits and commas are fine. */
  amount: string;
  method: string;
  paymentRef?: string;
  /** Generated once per form, so a double submit posts once. */
  idempotencyKey: string;
  /** Office only: skip the late fine this repayment would bring. */
  waiveFine?: boolean;
}

export type RepaymentError =
  | "invalid_amount"
  | "too_much"
  | "invalid_method"
  | "collector_cash_only"
  | "ref_required"
  | "ref_too_long"
  | "not_found"
  | "not_running";

export interface RepaymentView {
  id: string;
  amount: bigint;
  principal: bigint;
  interest: bigint;
  /** Late fine taken on top of the amount. */
  fine: bigint;
  channel: RepaymentChannel;
  paymentMethod: LoanPaymentMethod;
  paymentRef: string | null;
  entryNo: bigint;
  businessDate: string;
  createdAt: Date;
  createdBy: { nameEn: string | null; nameBn: string | null };
  /** The installments it went to, first and last. */
  firstSeq: number;
  lastSeq: number;
}

export type RepaymentResult =
  | { ok: true; repayment: RepaymentView; closed: boolean; replayed: boolean }
  | { ok: false; errors: Partial<Record<"amount" | "method" | "paymentRef" | "form", RepaymentError>>; owed?: bigint };

function repaymentQuery(ctx: TenantTx) {
  return ctx.tx
    .select({
      id: loanRepayment.id,
      amount: loanRepayment.amount,
      principal: loanRepayment.principal,
      interest: loanRepayment.interest,
      fine: loanRepayment.fine,
      channel: loanRepayment.channel,
      paymentMethod: loanRepayment.paymentMethod,
      paymentRef: loanRepayment.paymentRef,
      entryNo: sql<string>`(select je.entry_no from journal_entry je where je.tenant_id = ${loanRepayment.tenantId} and je.id = ${loanRepayment.journalEntryId})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
      businessDate: loanRepayment.businessDate,
      createdAt: loanRepayment.createdAt,
      byEn: appUser.nameEn,
      byBn: appUser.nameBn,
      firstSeq: sql<number>`(select min(x.seq) from loan_repayment_line x where x.tenant_id = ${loanRepayment.tenantId} and x.repayment_id = ${loanRepayment.id})`,
      lastSeq: sql<number>`(select max(x.seq) from loan_repayment_line x where x.tenant_id = ${loanRepayment.tenantId} and x.repayment_id = ${loanRepayment.id})`,
    })
    .from(loanRepayment)
    .innerJoin(appUser, and(eq(appUser.tenantId, loanRepayment.tenantId), eq(appUser.id, loanRepayment.createdBy)));
}

type Row = Awaited<ReturnType<ReturnType<typeof repaymentQuery>["execute"]>>[number];
const toView = (r: Row): RepaymentView => ({
  id: r.id,
  amount: r.amount,
  principal: r.principal,
  interest: r.interest,
  fine: r.fine,
  channel: r.channel,
  paymentMethod: r.paymentMethod,
  paymentRef: r.paymentRef,
  entryNo: r.entryNo,
  businessDate: r.businessDate,
  createdAt: r.createdAt,
  createdBy: { nameEn: r.byEn, nameBn: r.byBn },
  firstSeq: Number(r.firstSeq),
  lastSeq: Number(r.lastSeq),
});

/** A loan's repayments, newest first. */
export async function listRepayments(ctx: TenantTx, loanId: string): Promise<RepaymentView[]> {
  const rows = await repaymentQuery(ctx)
    .where(and(eq(loanRepayment.tenantId, ctx.tenantId), eq(loanRepayment.loanId, loanId)))
    .orderBy(desc(loanRepayment.createdAt));
  return rows.map(toView);
}

export async function repayLoan(
  ctx: TenantTx,
  input: RepaymentInput,
  actor: { userId: string; channel: RepaymentChannel; device?: string },
): Promise<RepaymentResult> {
  const errors: Partial<Record<"amount" | "method" | "paymentRef" | "form", RepaymentError>> = {};
  const amount = parseTaka(input.amount);
  if (amount === null || amount <= 0n) errors.amount = "invalid_amount";
  const method = PAYMENT_METHODS.find((m) => m === input.method);
  if (!method) errors.method = "invalid_method";
  else if (actor.channel === "collector" && method !== "cash") errors.method = "collector_cash_only";
  const paymentRef = input.paymentRef?.trim() || null;
  if (method === "mobile_wallet" && !paymentRef) errors.paymentRef = "ref_required";
  if (paymentRef && paymentRef.length > 64) errors.paymentRef = "ref_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  const { tx, tenantId } = ctx;
  // Repayments on one loan take turns, so two can't both pay the same installment.
  const [l] = await tx
    .select()
    .from(loan)
    .where(and(eq(loan.tenantId, tenantId), eq(loan.id, input.loanId)))
    .for("update");
  if (!l) return { ok: false, errors: { form: "not_found" } };

  // A form that already went through returns its repayment before the split
  // is worked out again: the first one has since changed what is owed.
  const [prior] = await repaymentQuery(ctx)
    .innerJoin(idempotencyKey, and(eq(idempotencyKey.tenantId, loanRepayment.tenantId), eq(idempotencyKey.resultId, loanRepayment.journalEntryId)))
    .where(and(eq(loanRepayment.tenantId, tenantId), eq(loanRepayment.loanId, l.id), eq(idempotencyKey.key, input.idempotencyKey)));
  if (prior) return { ok: true, repayment: toView(prior), closed: l.status === "closed", replayed: true };
  if (l.status !== "disbursed") return { ok: false, errors: { form: "not_running" } };

  const rows = await scheduleState(ctx, l.id);
  const owed = outstanding(rows).total;
  const lines = allocate(rows, amount!, l.allocation);
  if (!lines) return { ok: false, errors: { amount: "too_much" }, owed };
  const principal = lines.reduce((s, x) => s + x.principal, 0n);
  const interest = lines.reduce((s, x) => s + x.interest, 0n);
  const [day] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const late = lateFineFor(rows, lines, day!.d, l.lateFine, await finedSeqs(ctx, l.id));
  // Only the office can waive; a collector on a round collects what is due.
  const waived = input.waiveFine === true && actor.channel === "office" && late.fine > 0n;
  const fine = waived ? 0n : late.fine;

  const [owner] = await tx
    .select({ branchId: member.branchId, memberNo: member.memberNo, code: loanProduct.code })
    .from(member)
    .innerJoin(loanProduct, and(eq(loanProduct.tenantId, member.tenantId), eq(loanProduct.id, l.productId)))
    .where(and(eq(member.tenantId, tenantId), eq(member.id, l.memberId)));
  const debitKey = actor.channel === "collector" ? "cash_with_collector" : ACCOUNT_FOR[method!];
  const acc = await accountIdsByKey(ctx, [debitKey, "loans_receivable", "interest_income", "fine_income"] as const);
  const seqs = lines.length === 1 ? `installment ${lines[0]!.seq}` : `installments ${lines[0]!.seq}-${lines.at(-1)!.seq}`;
  const posted = await postEntry(ctx, {
    branchId: owner!.branchId,
    source: "loan_repayment",
    narration: `Loan repayment: ${owner!.code} loan #${l.loanNo}, member #${owner!.memberNo}, ${seqs}${paymentRef ? `, ref ${paymentRef}` : ""}` +
      (fine > 0n ? `, late fine for ${late.seqs.length} installment(s)` : ""),
    createdBy: actor.userId,
    idempotencyKey: input.idempotencyKey,
    device: actor.device,
    lines: [
      { accountId: acc[debitKey], debit: amount! + fine },
      ...(principal > 0n ? [{ accountId: acc.loans_receivable, credit: principal, memberId: l.memberId }] : []),
      ...(interest > 0n ? [{ accountId: acc.interest_income, credit: interest, memberId: l.memberId }] : []),
      ...(fine > 0n ? [{ accountId: acc.fine_income, credit: fine, memberId: l.memberId }] : []),
    ],
  });

  const [rep] = await tx
    .insert(loanRepayment)
    .values({
      tenantId,
      loanId: l.id,
      amount: amount!,
      principal,
      interest,
      fine,
      channel: actor.channel,
      paymentMethod: method!,
      paymentRef,
      journalEntryId: posted.entry.id,
      businessDate: posted.entry.businessDate,
      createdBy: actor.userId,
    })
    .returning({ id: loanRepayment.id });
  await tx.insert(loanRepaymentLine).values(lines.map((x) => ({ tenantId, repaymentId: rep!.id, loanId: l.id, ...x })));
  if (late.seqs.length) {
    await tx
      .insert(loanFine)
      .values(late.seqs.map((seq) => ({ tenantId, loanId: l.id, seq, repaymentId: rep!.id, amount: waived ? 0n : l.lateFine!, waived })));
  }

  const stillOwed = owed - amount!;
  const closed = stillOwed === 0n;
  if (closed) {
    await tx
      .update(loan)
      .set({ status: "closed", closedOn: posted.entry.businessDate })
      .where(and(eq(loan.tenantId, tenantId), eq(loan.id, l.id)));
  }
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "loan.repay",
    entityType: "loan",
    entityId: l.id,
    after: {
      loanNo: l.loanNo,
      entryNo: posted.entry.entryNo,
      amount: amount!.toString(),
      principal: principal.toString(),
      interest: interest.toString(),
      installments: lines.map((x) => x.seq),
      channel: actor.channel,
      paymentMethod: method,
      paymentRef,
      ...(late.seqs.length ? { lateInstallments: late.seqs, fine: fine.toString(), fineWaived: waived } : {}),
      ...(closed ? { closed: true } : {}),
    },
    device: actor.device,
  });
  await queueMemberSms(ctx, {
    memberId: l.memberId,
    kind: "loan_repayment",
    refId: posted.entry.id,
    text: (locale, somiti) =>
      loanRepaymentText({ somiti, productCode: owner!.code, loanNo: l.loanNo, entryNo: posted.entry.entryNo, amount: amount!, stillOwed, fine }, locale),
  });
  const [done] = await repaymentQuery(ctx).where(and(eq(loanRepayment.tenantId, tenantId), eq(loanRepayment.id, rep!.id)));
  return { ok: true, repayment: toView(done!), closed, replayed: false };
}

/** Repayments taken on the business day, for the overview. */
export async function repaymentsOn(ctx: TenantTx): Promise<{ count: number; amount: bigint }> {
  const { tx, tenantId } = ctx;
  const [day] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int`, amount: sql<string>`coalesce(sum(${loanRepayment.amount}), 0)` })
    .from(loanRepayment)
    .where(and(eq(loanRepayment.tenantId, tenantId), eq(loanRepayment.businessDate, day!.d)));
  return { count: row?.count ?? 0, amount: BigInt(row?.amount ?? 0) };
}
