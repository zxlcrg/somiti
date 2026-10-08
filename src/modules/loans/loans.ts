import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { TenantTx } from "@/db/client";
import { appUser, loan, loanInstallment, loanProduct, loanRepaymentLine, member, tenant } from "@/db/schema";
import { toLatinDigits } from "@/lib/digits";
import { applyBasisPoints, parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, LedgerError, postEntry } from "@/modules/ledger";
import { photoVersion } from "@/modules/members/photos";
import { parseSheetDate } from "@/modules/opening/parse";
import type { Allocation, InstallmentState } from "./allocate";
import type { ChargeLabel } from "./products";
import { buildSchedule, summarize, type LoanFrequency, type LoanMethod, type ScheduleSummary } from "./schedule";

/*
 * A loan takes three steps and at least two people (architecture doc,
 * "Security and controls"): an officer enters the application, a different
 * managing officer approves it, and the cashier pays it out. Only the
 * payout posts anything: Dr Loans receivable for the principal, Cr the
 * cash, bank or wallet it left from, and Cr Fee income for any processing
 * fee kept back from the money handed over.
 */

export type LoanStatus = "applied" | "approved" | "rejected" | "cancelled" | "disbursed" | "closed";
export const PAYMENT_METHODS = ["cash", "bank", "mobile_wallet"] as const;
export type LoanPaymentMethod = (typeof PAYMENT_METHODS)[number];
export const MAX_PURPOSE = 300;

const ACCOUNT_FOR: Record<LoanPaymentMethod, "cash_in_hand" | "bank" | "mobile_wallet"> = {
  cash: "cash_in_hand",
  bank: "bank",
  mobile_wallet: "mobile_wallet",
};

type Actor = { userId: string; device?: string };
type Person = { nameEn: string | null; nameBn: string | null };

// ---------- Terms ----------

export interface TermsPreview extends ScheduleSummary {
  principal: bigint;
  installments: number;
  processingFee: bigint;
  /** What the member actually receives: the principal less the fee. */
  handedOver: bigint;
}

/** What a loan on these terms costs, as shown while the application is typed. */
export function previewTerms(
  product: { method: LoanMethod; rateBp: number; frequency: LoanFrequency; processingFeeBp: number },
  principal: bigint,
  installments: number,
  from: string,
): TermsPreview {
  const rows = buildSchedule({ principal, method: product.method, rateBp: product.rateBp, frequency: product.frequency, installments }, from);
  const processingFee = applyBasisPoints(principal, BigInt(product.processingFeeBp));
  return { ...summarize(rows), principal, installments, processingFee, handedOver: principal - processingFee };
}

// ---------- Applying ----------

export interface LoanApplicationInput {
  memberId: string;
  productId: string;
  /** Typed taka; Bangla digits are fine. */
  amount: string;
  installments: string;
  purpose?: string;
  /** Generated once per form, so a double submit makes one application. */
  submitKey: string;
}

export type LoanApplicationError =
  | "invalid_amount"
  | "below_min"
  | "above_max"
  | "invalid_installments"
  | "too_many_installments"
  | "installment_too_small"
  | "purpose_too_long"
  | "invalid_product"
  | "product_inactive"
  | "member_inactive"
  | "already_open"
  | "not_found";

export type LoanApplicationErrors = Partial<Record<"amount" | "installments" | "purpose" | "productId" | "form", LoanApplicationError>>;

export type LoanApplicationResult = { ok: true; loanId: string; loanNo: number; replayed: boolean } | { ok: false; errors: LoanApplicationErrors };

async function businessDate({ tx, tenantId }: TenantTx): Promise<string> {
  const [row] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  return row!.d;
}

export async function applyForLoan(ctx: TenantTx, input: LoanApplicationInput, actor: Actor): Promise<LoanApplicationResult> {
  const { tx, tenantId } = ctx;
  const [prior] = await tx
    .select({ id: loan.id, loanNo: loan.loanNo, appliedBy: loan.appliedBy, memberId: loan.memberId })
    .from(loan)
    .where(and(eq(loan.tenantId, tenantId), eq(loan.submitKey, input.submitKey)));
  if (prior) {
    if (prior.appliedBy !== actor.userId || prior.memberId !== input.memberId) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "This submit key was already used");
    }
    return { ok: true, loanId: prior.id, loanNo: prior.loanNo, replayed: true };
  }

  const [product] = await tx
    .select()
    .from(loanProduct)
    .where(and(eq(loanProduct.tenantId, tenantId), eq(loanProduct.id, input.productId)));
  if (!product) return { ok: false, errors: { productId: "invalid_product" } };
  if (!product.active) return { ok: false, errors: { productId: "product_inactive" } };

  const errors: LoanApplicationErrors = {};
  const principal = parseTaka(input.amount);
  if (principal === null || principal <= 0n) errors.amount = "invalid_amount";
  else if (principal < product.minAmount) errors.amount = "below_min";
  else if (principal > product.maxAmount) errors.amount = "above_max";
  const nText = toLatinDigits(input.installments.trim());
  const n = /^\d{1,3}$/.test(nText) ? Number(nText) : NaN;
  if (!(n >= 1)) errors.installments = "invalid_installments";
  else if (n > product.maxInstallments) errors.installments = "too_many_installments";
  else if (principal && principal > 0n && principal / BigInt(n) < 100n) errors.installments = "installment_too_small";
  const purpose = input.purpose?.trim() || null;
  if (purpose && purpose.length > MAX_PURPOSE) errors.purpose = "purpose_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  const [owner] = await tx
    .select({ status: member.status })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, input.memberId)));
  if (!owner) return { ok: false, errors: { form: "not_found" } };
  if (owner.status !== "active") return { ok: false, errors: { form: "member_inactive" } };

  // Loan numbers are gap-free per somiti; applications take turns for the next one.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`loan_no:${tenantId}`}))`);
  const [open] = await tx
    .select({ id: loan.id })
    .from(loan)
    .where(
      and(
        eq(loan.tenantId, tenantId),
        eq(loan.memberId, input.memberId),
        eq(loan.productId, product.id),
        inArray(loan.status, ["applied", "approved", "disbursed"]),
      ),
    );
  if (open) return { ok: false, errors: { productId: "already_open" } };
  const [last] = await tx
    .select({ n: sql<number>`coalesce(max(${loan.loanNo}), 0)` })
    .from(loan)
    .where(eq(loan.tenantId, tenantId));
  const loanNo = Number(last?.n ?? 0) + 1;
  const processingFee = applyBasisPoints(principal!, BigInt(product.processingFeeBp));

  const [row] = await tx
    .insert(loan)
    .values({
      tenantId,
      loanNo,
      memberId: input.memberId,
      productId: product.id,
      principal: principal!,
      method: product.method,
      rateBp: product.rateBp,
      frequency: product.frequency,
      installments: n,
      processingFee,
      allocation: product.allocation,
      purpose,
      appliedBy: actor.userId,
      appliedOn: await businessDate(ctx),
      submitKey: input.submitKey,
    })
    .returning({ id: loan.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "loan.apply",
    entityType: "loan",
    entityId: row!.id,
    after: { loanNo, memberId: input.memberId, productCode: product.code, principal: principal!.toString(), installments: n, rateBp: product.rateBp, method: product.method, purpose },
    device: actor.device,
  });
  return { ok: true, loanId: row!.id, loanNo, replayed: false };
}

// ---------- Deciding ----------

export type LoanDecisionError =
  | "not_found"
  | "wrong_status"
  | "self_decision"
  | "note_required"
  | "invalid_date"
  | "meeting_after_today"
  | "invalid_method"
  | "ref_required"
  | "ref_too_long"
  | "product_inactive"
  | "member_inactive";

export type LoanDecisionResult = { ok: true; entryNo?: bigint } | { ok: false; error: LoanDecisionError };

async function lockLoan(ctx: TenantTx, loanId: string) {
  const [row] = await ctx.tx
    .select()
    .from(loan)
    .where(and(eq(loan.tenantId, ctx.tenantId), eq(loan.id, loanId)))
    .for("update");
  return row;
}

/** A different managing officer approves; the date of the committee meeting may be noted. */
export async function approveLoan(ctx: TenantTx, d: { loanId: string; meetingOn?: string; note?: string } & Actor): Promise<LoanDecisionResult> {
  const l = await lockLoan(ctx, d.loanId);
  if (!l) return { ok: false, error: "not_found" };
  if (l.status !== "applied") return { ok: false, error: "wrong_status" };
  if (l.appliedBy === d.userId) return { ok: false, error: "self_decision" };
  let meetingOn: string | null = null;
  if (d.meetingOn?.trim()) {
    meetingOn = /^\d{4}-\d{2}-\d{2}$/.test(d.meetingOn.trim()) ? d.meetingOn.trim() : parseSheetDate(d.meetingOn);
    if (!meetingOn) return { ok: false, error: "invalid_date" };
    if (meetingOn > (await businessDate(ctx))) return { ok: false, error: "meeting_after_today" };
  }
  const note = d.note?.trim().slice(0, 1000) || null;
  await ctx.tx
    .update(loan)
    .set({ status: "approved", decidedBy: d.userId, decidedAt: sql`now()`, meetingOn, decisionNote: note })
    .where(and(eq(loan.tenantId, ctx.tenantId), eq(loan.id, l.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "loan.approve",
    entityType: "loan",
    entityId: l.id,
    after: { loanNo: l.loanNo, meetingOn, note },
    device: d.device,
  });
  return { ok: true };
}

/** Turns an application down, with the reason the member is told. */
export async function rejectLoan(ctx: TenantTx, d: { loanId: string; note: string } & Actor): Promise<LoanDecisionResult> {
  const note = d.note.trim();
  if (!note) return { ok: false, error: "note_required" };
  const l = await lockLoan(ctx, d.loanId);
  if (!l) return { ok: false, error: "not_found" };
  if (l.status !== "applied") return { ok: false, error: "wrong_status" };
  if (l.appliedBy === d.userId) return { ok: false, error: "self_decision" };
  await ctx.tx
    .update(loan)
    .set({ status: "rejected", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note.slice(0, 1000) })
    .where(and(eq(loan.tenantId, ctx.tenantId), eq(loan.id, l.id)));
  await recordAudit(ctx, { actorUserId: d.userId, action: "loan.reject", entityType: "loan", entityId: l.id, after: { loanNo: l.loanNo, note }, device: d.device });
  return { ok: true };
}

/**
 * Withdraws an application or an approved loan not yet paid out, for
 * example when the member no longer wants it. A reason is required once it
 * has been approved, since someone else signed it off.
 */
export async function cancelLoan(ctx: TenantTx, d: { loanId: string; note?: string } & Actor): Promise<LoanDecisionResult> {
  const l = await lockLoan(ctx, d.loanId);
  if (!l) return { ok: false, error: "not_found" };
  if (l.status !== "applied" && l.status !== "approved") return { ok: false, error: "wrong_status" };
  const note = d.note?.trim().slice(0, 1000) || null;
  if (l.status === "approved" && !note) return { ok: false, error: "note_required" };
  await ctx.tx
    .update(loan)
    .set(
      l.status === "applied"
        ? { status: "cancelled", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note }
        : { status: "cancelled", decisionNote: note },
    )
    .where(and(eq(loan.tenantId, ctx.tenantId), eq(loan.id, l.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "loan.cancel",
    entityType: "loan",
    entityId: l.id,
    before: { status: l.status },
    after: { loanNo: l.loanNo, note },
    device: d.device,
  });
  return { ok: true };
}

// ---------- Paying out ----------

/**
 * The cashier pays out an approved loan on the current business date. The
 * schedule is written from that date: the first installment falls one
 * period later.
 */
export async function disburseLoan(
  ctx: TenantTx,
  d: { loanId: string; method: string; paymentRef?: string } & Actor,
): Promise<LoanDecisionResult> {
  const method = PAYMENT_METHODS.find((m) => m === d.method);
  if (!method) return { ok: false, error: "invalid_method" };
  const paymentRef = d.paymentRef?.trim() || null;
  if (method === "mobile_wallet" && !paymentRef) return { ok: false, error: "ref_required" };
  if (paymentRef && paymentRef.length > 64) return { ok: false, error: "ref_too_long" };

  const l = await lockLoan(ctx, d.loanId);
  if (!l) return { ok: false, error: "not_found" };
  if (l.status !== "approved") return { ok: false, error: "wrong_status" };
  const { tx, tenantId } = ctx;
  const [owner] = await tx
    .select({ status: member.status, branchId: member.branchId, memberNo: member.memberNo, code: loanProduct.code })
    .from(member)
    .innerJoin(loanProduct, and(eq(loanProduct.tenantId, member.tenantId), eq(loanProduct.id, l.productId)))
    .where(and(eq(member.tenantId, tenantId), eq(member.id, l.memberId)));
  if (!owner) return { ok: false, error: "not_found" };
  if (owner.status !== "active") return { ok: false, error: "member_inactive" };

  const payFrom = ACCOUNT_FOR[method];
  const acc = await accountIdsByKey(ctx, ["loans_receivable", "fee_income", payFrom] as const);
  const posted = await postEntry(ctx, {
    branchId: owner.branchId,
    source: "loan_disbursement",
    narration: `Loan disbursed: ${owner.code} loan #${l.loanNo}, member #${owner.memberNo}${paymentRef ? `, ref ${paymentRef}` : ""}`,
    createdBy: d.userId,
    idempotencyKey: `loan_disbursement:${l.id}`,
    device: d.device,
    lines: [
      { accountId: acc.loans_receivable, debit: l.principal, memberId: l.memberId },
      { accountId: acc[payFrom], credit: l.principal - l.processingFee },
      ...(l.processingFee > 0n ? [{ accountId: acc.fee_income, credit: l.processingFee, memberId: l.memberId }] : []),
    ],
  });
  const schedule = buildSchedule(l, posted.entry.businessDate);
  await tx.insert(loanInstallment).values(schedule.map((s) => ({ tenantId, loanId: l.id, ...s })));
  await tx
    .update(loan)
    .set({ status: "disbursed", disbursedBy: d.userId, disbursedOn: posted.entry.businessDate, paymentMethod: method, paymentRef, entryId: posted.entry.id })
    .where(and(eq(loan.tenantId, tenantId), eq(loan.id, l.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "loan.disburse",
    entityType: "loan",
    entityId: l.id,
    after: {
      loanNo: l.loanNo,
      entryNo: posted.entry.entryNo,
      businessDate: posted.entry.businessDate,
      principal: l.principal.toString(),
      fee: l.processingFee.toString(),
      paymentMethod: method,
      paymentRef,
    },
    device: d.device,
  });
  return { ok: true, entryNo: posted.entry.entryNo };
}

// ---------- Reading ----------

export interface LoanView {
  id: string;
  loanNo: number;
  status: LoanStatus;
  member: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null; phone: string; photoVersion: string | null };
  product: { id: string; code: string; nameEn: string; nameBn: string | null; chargeLabel: ChargeLabel };
  principal: bigint;
  method: LoanMethod;
  rateBp: number;
  frequency: LoanFrequency;
  installments: number;
  processingFee: bigint;
  allocation: Allocation;
  purpose: string | null;
  appliedOn: string;
  createdAt: Date;
  appliedBy: Person & { id: string };
  decidedBy: (Person & { id: string }) | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  meetingOn: string | null;
  disbursedBy: Person | null;
  disbursedOn: string | null;
  paymentMethod: LoanPaymentMethod | null;
  paymentRef: string | null;
  entryNo: bigint | null;
  closedOn: string | null;
  /** Repaid so far. */
  paidPrincipal: bigint;
  paidInterest: bigint;
}

const applicant = alias(appUser, "applicant");
const decider = alias(appUser, "decider");
const payer = alias(appUser, "payer");

function loanQuery(ctx: TenantTx) {
  return ctx.tx
    .select({
      id: loan.id,
      loanNo: loan.loanNo,
      status: loan.status,
      memberId: member.id,
      memberNo: member.memberNo,
      memberEn: member.nameEn,
      memberBn: member.nameBn,
      phone: member.phone,
      photoSha: sql<string | null>`(select p.sha256 from member_photo p where p.tenant_id = ${loan.tenantId} and p.member_id = ${loan.memberId} and p.removed_at is null order by p.created_at desc limit 1)`,
      productId: loanProduct.id,
      code: loanProduct.code,
      productEn: loanProduct.nameEn,
      productBn: loanProduct.nameBn,
      chargeLabel: loanProduct.chargeLabel,
      principal: loan.principal,
      method: loan.method,
      rateBp: loan.rateBp,
      frequency: loan.frequency,
      installments: loan.installments,
      processingFee: loan.processingFee,
      allocation: loan.allocation,
      closedOn: loan.closedOn,
      paidPrincipal: sql<string>`(select coalesce(sum(p.principal), 0) from loan_repayment p where p.tenant_id = ${loan.tenantId} and p.loan_id = ${loan.id})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
      paidInterest: sql<string>`(select coalesce(sum(p.interest), 0) from loan_repayment p where p.tenant_id = ${loan.tenantId} and p.loan_id = ${loan.id})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
      purpose: loan.purpose,
      appliedOn: loan.appliedOn,
      createdAt: loan.createdAt,
      appliedById: loan.appliedBy,
      appliedEn: applicant.nameEn,
      appliedBn: applicant.nameBn,
      decidedById: loan.decidedBy,
      decidedEn: decider.nameEn,
      decidedBn: decider.nameBn,
      decidedAt: loan.decidedAt,
      decisionNote: loan.decisionNote,
      meetingOn: loan.meetingOn,
      paidEn: payer.nameEn,
      paidBn: payer.nameBn,
      disbursedOn: loan.disbursedOn,
      paymentMethod: loan.paymentMethod,
      paymentRef: loan.paymentRef,
      entryNo: sql<string | null>`(select je.entry_no from journal_entry je where je.tenant_id = ${loan.tenantId} and je.id = ${loan.entryId})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
    })
    .from(loan)
    .innerJoin(member, and(eq(member.tenantId, loan.tenantId), eq(member.id, loan.memberId)))
    .innerJoin(loanProduct, and(eq(loanProduct.tenantId, loan.tenantId), eq(loanProduct.id, loan.productId)))
    .innerJoin(applicant, and(eq(applicant.tenantId, loan.tenantId), eq(applicant.id, loan.appliedBy)))
    .leftJoin(decider, and(eq(decider.tenantId, loan.tenantId), eq(decider.id, loan.decidedBy)))
    .leftJoin(payer, and(eq(payer.tenantId, loan.tenantId), eq(payer.id, loan.disbursedBy)));
}

type LoanRow = Awaited<ReturnType<ReturnType<typeof loanQuery>["execute"]>>[number];

function view(r: LoanRow): LoanView {
  return {
    id: r.id,
    loanNo: r.loanNo,
    status: r.status,
    member: { id: r.memberId, memberNo: r.memberNo, nameEn: r.memberEn, nameBn: r.memberBn, phone: r.phone, photoVersion: r.photoSha ? photoVersion(r.photoSha) : null },
    product: { id: r.productId, code: r.code, nameEn: r.productEn, nameBn: r.productBn, chargeLabel: r.chargeLabel },
    principal: r.principal,
    method: r.method,
    rateBp: r.rateBp,
    frequency: r.frequency,
    installments: r.installments,
    processingFee: r.processingFee,
    allocation: r.allocation,
    purpose: r.purpose,
    appliedOn: r.appliedOn,
    createdAt: r.createdAt,
    appliedBy: { id: r.appliedById, nameEn: r.appliedEn, nameBn: r.appliedBn },
    decidedBy: r.decidedById ? { id: r.decidedById, nameEn: r.decidedEn, nameBn: r.decidedBn } : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    meetingOn: r.meetingOn,
    disbursedBy: r.disbursedOn ? { nameEn: r.paidEn, nameBn: r.paidBn } : null,
    disbursedOn: r.disbursedOn,
    paymentMethod: r.paymentMethod,
    paymentRef: r.paymentRef,
    entryNo: r.entryNo,
    closedOn: r.closedOn,
    paidPrincipal: r.paidPrincipal,
    paidInterest: r.paidInterest,
  };
}

export interface LoanDetail extends LoanView {
  /** The written schedule once paid out; before that, a projection from today. */
  schedule: InstallmentState[];
  projected: boolean;
  summary: ScheduleSummary;
}

export async function getLoan(ctx: TenantTx, loanId: string): Promise<LoanDetail | null> {
  const [row] = await loanQuery(ctx).where(and(eq(loan.tenantId, ctx.tenantId), eq(loan.id, loanId)));
  if (!row) return null;
  const v = view(row);
  let schedule: InstallmentState[];
  let projected = false;
  if (v.disbursedOn) {
    schedule = await scheduleState(ctx, v.id);
  } else {
    schedule = buildSchedule(v, await businessDate(ctx)).map((r) => ({ ...r, paidPrincipal: 0n, paidInterest: 0n }));
    projected = true;
  }
  return { ...v, schedule, projected, summary: summarize(schedule) };
}

/** The written schedule with what each installment has had paid against it. */
export async function scheduleState(ctx: TenantTx, loanId: string): Promise<InstallmentState[]> {
  const { tx, tenantId } = ctx;
  const paid = tx
    .select({
      seq: loanRepaymentLine.seq,
      principal: sql<string>`sum(${loanRepaymentLine.principal})`.as("paid_principal"),
      interest: sql<string>`sum(${loanRepaymentLine.interest})`.as("paid_interest"),
    })
    .from(loanRepaymentLine)
    .where(and(eq(loanRepaymentLine.tenantId, tenantId), eq(loanRepaymentLine.loanId, loanId)))
    .groupBy(loanRepaymentLine.seq)
    .as("paid");
  const rows = await tx
    .select({
      seq: loanInstallment.seq,
      dueOn: loanInstallment.dueOn,
      principal: loanInstallment.principal,
      interest: loanInstallment.interest,
      paidPrincipal: paid.principal,
      paidInterest: paid.interest,
    })
    .from(loanInstallment)
    .leftJoin(paid, eq(paid.seq, loanInstallment.seq))
    .where(and(eq(loanInstallment.tenantId, tenantId), eq(loanInstallment.loanId, loanId)))
    .orderBy(asc(loanInstallment.seq));
  return rows.map((r) => ({ ...r, paidPrincipal: BigInt(r.paidPrincipal ?? 0), paidInterest: BigInt(r.paidInterest ?? 0) }));
}

export async function listLoans(
  ctx: TenantTx,
  opts: { status?: LoanStatus | LoanStatus[]; memberId?: string; limit?: number } = {},
): Promise<LoanView[]> {
  const statuses = opts.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) : undefined;
  const rows = await loanQuery(ctx)
    .where(
      and(
        eq(loan.tenantId, ctx.tenantId),
        statuses ? inArray(loan.status, statuses) : undefined,
        opts.memberId ? eq(loan.memberId, opts.memberId) : undefined,
      ),
    )
    .orderBy(desc(loan.createdAt))
    .limit(opts.limit ?? 100);
  return rows.map(view);
}

export interface LoanStats {
  applied: number;
  approved: number;
  live: number;
  /** Principal still owed on loans paid out and not yet closed. */
  outstandingPrincipal: bigint;
  /** Principal paid out in each of the last six months, oldest first. */
  monthly: { month: string; amount: bigint; count: number }[];
}

export async function loanStats(ctx: TenantTx): Promise<LoanStats> {
  const { tx, tenantId } = ctx;
  const [c] = await tx
    .select({
      applied: sql<number>`count(*) filter (where ${loan.status} = 'applied')::int`,
      approved: sql<number>`count(*) filter (where ${loan.status} = 'approved')::int`,
      live: sql<number>`count(*) filter (where ${loan.status} = 'disbursed')::int`,
      outstanding: sql<string>`coalesce(sum(${loan.principal} - (select coalesce(sum(p.principal), 0) from loan_repayment p where p.tenant_id = loan.tenant_id and p.loan_id = loan.id)) filter (where ${loan.status} = 'disbursed'), 0)`,
    })
    .from(loan)
    .where(eq(loan.tenantId, tenantId));
  const today = await businessDate(ctx);
  const months = await tx.execute<{ month: string; amount: string; count: number }>(sql`
    select to_char(m, 'YYYY-MM') as month,
           coalesce(sum(l.principal), 0)::text as amount,
           count(l.id)::int as count
      from generate_series(date_trunc('month', ${today}::date) - interval '5 months', date_trunc('month', ${today}::date), interval '1 month') m
      left join loan l on l.tenant_id = ${tenantId} and l.disbursed_on >= m and l.disbursed_on < m + interval '1 month'
     group by m order by m`);
  return {
    applied: c!.applied,
    approved: c!.approved,
    live: c!.live,
    outstandingPrincipal: BigInt(c!.outstanding),
    monthly: months.rows.map((r) => ({ month: r.month, amount: BigInt(r.amount), count: r.count })),
  };
}

/** Loans waiting on this officer: applications someone else entered, if they approve; approved loans, if they pay out. */
export async function loansWaitingFor(ctx: TenantTx, userId: string, can: { decide: boolean; pay: boolean }): Promise<number> {
  if (!can.decide && !can.pay) return 0;
  const [row] = await ctx.tx
    .select({
      n: sql<number>`(count(*) filter (where ${can.decide} and ${loan.status} = 'applied' and ${loan.appliedBy} <> ${userId})
                    + count(*) filter (where ${can.pay} and ${loan.status} = 'approved'))::int`,
    })
    .from(loan)
    .where(and(eq(loan.tenantId, ctx.tenantId), inArray(loan.status, ["applied", "approved"])));
  return row?.n ?? 0;
}
