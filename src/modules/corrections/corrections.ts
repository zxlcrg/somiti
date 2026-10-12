import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { TenantTx } from "@/db/client";
import {
  appUser,
  entryCorrection,
  loan,
  loanFine,
  loanProduct,
  loanReschedule,
  loanRepayment,
  loanWriteOff,
  member,
  savingsAccount,
  savingsProduct,
  savingsTransaction,
  shareTransaction,
  tenant,
} from "@/db/schema";
import { recordAudit } from "@/modules/audit/log";
import { reverseEntry } from "@/modules/ledger";
import { heldBy } from "@/modules/savings/collections";
import { available } from "@/modules/savings/withdrawals";

/*
 * Undoing a member transaction recorded by mistake (accounting check,
 * 2026-10-12). One officer asks with a reason; a different managing officer
 * approves. Approval posts the reversal of the original entry on today's
 * business date; the original stays in the books, marked reversed, and every
 * balance, passbook and schedule stops counting it. The right transaction is
 * then recorded again on its own page.
 *
 * Only the latest repayment of a running loan can be undone, and not one that
 * took a late fine or came before a new schedule, so the loan's schedule never
 * has to be worked out again from the middle.
 */

export const MAX_CORRECTION_REASON = 300;
export const CORRECTABLE = ["savings_deposit", "savings_withdrawal", "share_purchase", "loan_repayment"] as const;
export type CorrectionKind = (typeof CORRECTABLE)[number];
export type CorrectionStatus = "pending" | "approved" | "rejected" | "cancelled";

const MAKERS = new Set(["admin", "president", "secretary", "cashier"]);
const CHECKERS = new Set(["admin", "president", "secretary"]);

/** Who may ask for a correction: the officers who record transactions at the office. */
export function canRequestCorrections(roles: readonly string[]): boolean {
  return roles.some((r) => MAKERS.has(r));
}

/** Who may approve one: a managing officer other than the one who asked. */
export function canApproveCorrections(roles: readonly string[]): boolean {
  return roles.some((r) => CHECKERS.has(r));
}

/** Why a transaction can't be undone right now. */
export type CorrectionBlocker =
  | "not_correctable"
  | "already_reversed"
  | "already_pending"
  | "account_closed"
  | "balance_too_low"
  | "collector_handed_over"
  | "member_not_active"
  | "loan_not_running"
  | "not_latest"
  | "has_fine"
  | "rescheduled_after"
  | "write_off_pending";

export type CorrectionError = CorrectionBlocker | "not_found" | "reason_required" | "reason_too_long" | "wrong_status" | "self_decision" | "note_required" | "not_requester";

export interface CorrectionTarget {
  entryId: string;
  entryNo: bigint;
  kind: CorrectionKind;
  businessDate: string;
  /** Everything the entry moved, fines included. */
  total: bigint;
  /** The deposit, withdrawal, share or repayment amount on its own. */
  amount: bigint;
  member: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null };
  /** Where the transaction shows: a savings account, a loan or the member's shares. */
  savingsAccountId: string | null;
  /** The savings product or loan product code with the account or loan number. */
  account: { code: string; no: number } | null;
  loanId: string | null;
  recordedBy: { nameEn: string | null; nameBn: string | null };
  narration: string;
  blocker: CorrectionBlocker | null;
}

const notReversed = (alias: string) =>
  sql.raw(`not exists (select 1 from journal_entry r where r.tenant_id = ${alias}.tenant_id and r.reverses_id = ${alias}.journal_entry_id)`);

async function entryTotal({ tx, tenantId }: TenantTx, entryId: string): Promise<bigint> {
  const res = await tx.execute<{ total: string }>(
    sql`select coalesce(sum(debit), 0)::text as total from journal_line where tenant_id = ${tenantId} and entry_id = ${entryId}`,
  );
  return BigInt(res.rows[0]?.total ?? 0);
}

/**
 * What a journal entry was, as a member transaction, and whether it can be
 * undone now. Undefined for an entry that isn't one of the kinds above.
 */
export async function correctionTarget(ctx: TenantTx, entryId: string): Promise<CorrectionTarget | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) return undefined;
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .execute<{ id: string; entry_no: string; source: string; business_date: string; narration: string; reversed: boolean }>(sql`
      select je.id, je.entry_no::text, je.source::text, je.business_date::text, je.narration,
             exists (select 1 from journal_entry r where r.tenant_id = je.tenant_id and r.reverses_id = je.id) as reversed
        from journal_entry je where je.tenant_id = ${tenantId} and je.id = ${entryId}`)
    .then((r) => r.rows);
  const e = row && { id: row.id, entryNo: BigInt(row.entry_no), source: row.source, businessDate: row.business_date, narration: row.narration, reversed: row.reversed };
  if (!e || !(CORRECTABLE as readonly string[]).includes(e.source)) return undefined;
  const kind = e.source as CorrectionKind;
  const total = await entryTotal(ctx, e.id);

  let memberId: string;
  let amount: bigint;
  let createdBy: string;
  let savingsAccountId: string | null = null;
  let account: { code: string; no: number } | null = null;
  let loanId: string | null = null;
  let blocker: CorrectionBlocker | null = null;

  if (kind === "savings_deposit" || kind === "savings_withdrawal") {
    const [t] = await tx
      .select({
        accountId: savingsTransaction.accountId,
        amount: savingsTransaction.amount,
        channel: savingsTransaction.channel,
        createdBy: savingsTransaction.createdBy,
        memberId: savingsAccount.memberId,
        status: savingsAccount.status,
        accountNo: savingsAccount.accountNo,
        code: savingsProduct.code,
      })
      .from(savingsTransaction)
      .innerJoin(savingsAccount, and(eq(savingsAccount.tenantId, savingsTransaction.tenantId), eq(savingsAccount.id, savingsTransaction.accountId)))
      .innerJoin(savingsProduct, and(eq(savingsProduct.tenantId, savingsAccount.tenantId), eq(savingsProduct.id, savingsAccount.productId)))
      .where(and(eq(savingsTransaction.tenantId, tenantId), eq(savingsTransaction.journalEntryId, e.id)));
    if (!t) return undefined;
    ({ memberId, amount, createdBy } = t);
    savingsAccountId = t.accountId;
    account = { code: t.code, no: t.accountNo };
    if (t.status !== "active") blocker = "account_closed";
    else if (kind === "savings_deposit") {
      const [bal] = await tx.execute<{ balance: string }>(sql`
        select coalesce(sum(case when t.kind = 'withdrawal' then -t.amount else t.amount end), 0)::text as balance
          from savings_transaction t where t.tenant_id = ${tenantId} and t.account_id = ${t.accountId} and ${notReversed("t")}`).then((r) => r.rows);
      if ((await available(ctx, t.accountId, BigInt(bal?.balance ?? 0))) < t.amount) blocker = "balance_too_low";
      else if (t.channel === "collector" && (await heldBy(ctx, t.createdBy)) < total) blocker = "collector_handed_over";
    }
  } else if (kind === "share_purchase") {
    const [s] = await tx
      .select({ memberId: shareTransaction.memberId, amount: shareTransaction.amount, createdBy: shareTransaction.createdBy, status: member.status })
      .from(shareTransaction)
      .innerJoin(member, and(eq(member.tenantId, shareTransaction.tenantId), eq(member.id, shareTransaction.memberId)))
      .where(and(eq(shareTransaction.tenantId, tenantId), eq(shareTransaction.journalEntryId, e.id)));
    if (!s) return undefined;
    ({ memberId, amount, createdBy } = s);
    if (s.status !== "active") blocker = "member_not_active";
  } else {
    const [p] = await tx
      .select({
        id: loanRepayment.id,
        loanId: loanRepayment.loanId,
        amount: loanRepayment.amount,
        channel: loanRepayment.channel,
        createdBy: loanRepayment.createdBy,
        memberId: loan.memberId,
        status: loan.status,
        loanNo: loan.loanNo,
        code: loanProduct.code,
      })
      .from(loanRepayment)
      .innerJoin(loan, and(eq(loan.tenantId, loanRepayment.tenantId), eq(loan.id, loanRepayment.loanId)))
      .innerJoin(loanProduct, and(eq(loanProduct.tenantId, loan.tenantId), eq(loanProduct.id, loan.productId)))
      .where(and(eq(loanRepayment.tenantId, tenantId), eq(loanRepayment.journalEntryId, e.id)));
    if (!p) return undefined;
    ({ memberId, amount, createdBy } = p);
    loanId = p.loanId;
    account = { code: p.code, no: p.loanNo };
    // Compared in the database: a JavaScript date drops the microseconds.
    const since = sql`(select r.created_at from loan_repayment r where r.tenant_id = ${tenantId} and r.id = ${p.id})`;
    const [later] = await tx
      .select({ id: loanRepayment.id })
      .from(loanRepayment)
      .where(and(eq(loanRepayment.tenantId, tenantId), eq(loanRepayment.loanId, p.loanId), ne(loanRepayment.id, p.id), sql`${loanRepayment.createdAt} >= ${since}`, sql`${notReversed("loan_repayment")}`))
      .limit(1);
    const [fine] = await tx.select({ seq: loanFine.seq }).from(loanFine).where(and(eq(loanFine.tenantId, tenantId), eq(loanFine.repaymentId, p.id))).limit(1);
    const [moved] = await tx
      .select({ id: loanReschedule.id })
      .from(loanReschedule)
      .where(and(eq(loanReschedule.tenantId, tenantId), eq(loanReschedule.loanId, p.loanId), sql`${loanReschedule.createdAt} >= ${since}`))
      .limit(1);
    const [writeOff] = await tx
      .select({ id: loanWriteOff.id })
      .from(loanWriteOff)
      .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.loanId, p.loanId), eq(loanWriteOff.status, "pending")))
      .limit(1);
    if (p.status !== "disbursed") blocker = "loan_not_running";
    else if (later) blocker = "not_latest";
    else if (fine) blocker = "has_fine";
    else if (moved) blocker = "rescheduled_after";
    else if (writeOff) blocker = "write_off_pending";
    else if (p.channel === "collector" && (await heldBy(ctx, p.createdBy)) < total) blocker = "collector_handed_over";
  }

  const [pending] = await tx
    .select({ id: entryCorrection.id })
    .from(entryCorrection)
    .where(and(eq(entryCorrection.tenantId, tenantId), eq(entryCorrection.entryId, e.id), eq(entryCorrection.status, "pending")));
  if (e.reversed) blocker = "already_reversed";
  else if (pending && !blocker) blocker = "already_pending";

  const [m] = await tx
    .select({ id: member.id, memberNo: member.memberNo, nameEn: member.nameEn, nameBn: member.nameBn })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, memberId)));
  const [by] = await tx
    .select({ nameEn: appUser.nameEn, nameBn: appUser.nameBn })
    .from(appUser)
    .where(and(eq(appUser.tenantId, tenantId), eq(appUser.id, createdBy)));
  return {
    entryId: e.id,
    entryNo: e.entryNo,
    kind,
    businessDate: e.businessDate,
    total,
    amount,
    member: m!,
    savingsAccountId,
    account,
    loanId,
    recordedBy: by ?? { nameEn: null, nameBn: null },
    narration: e.narration,
    blocker,
  };
}

/** Locks what the entry belongs to, so a deposit, repayment or handover can't slip in while it is checked. */
async function lockFor(ctx: TenantTx, t: CorrectionTarget) {
  const { tx, tenantId } = ctx;
  if (t.savingsAccountId) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`savings_withdrawal:${tenantId}:${t.savingsAccountId}`}))`);
  if (t.loanId) await tx.select({ id: loan.id }).from(loan).where(and(eq(loan.tenantId, tenantId), eq(loan.id, t.loanId))).for("update");
}

async function businessDate({ tx, tenantId }: TenantTx): Promise<string> {
  const [row] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  return row!.d;
}

type Actor = { userId: string; device?: string };

/** Asks to undo a member transaction. Nothing posts until a different officer approves. */
export async function requestCorrection(
  ctx: TenantTx,
  input: { entryId: string; reason: string; submitKey: string },
  actor: Actor,
): Promise<{ ok: true; correctionId: string; replayed: boolean } | { ok: false; error: CorrectionError }> {
  const { tx, tenantId } = ctx;
  const [earlier] = await tx
    .select({ id: entryCorrection.id, entryId: entryCorrection.entryId })
    .from(entryCorrection)
    .where(and(eq(entryCorrection.tenantId, tenantId), eq(entryCorrection.submitKey, input.submitKey)));
  if (earlier?.entryId === input.entryId) return { ok: true, correctionId: earlier.id, replayed: true };

  const reason = input.reason.trim();
  if (reason.length < 3) return { ok: false, error: "reason_required" };
  if (reason.length > MAX_CORRECTION_REASON) return { ok: false, error: "reason_too_long" };
  const first = await correctionTarget(ctx, input.entryId);
  if (!first) return { ok: false, error: "not_found" };
  await lockFor(ctx, first);
  const t = (await correctionTarget(ctx, input.entryId))!;
  if (t.blocker) return { ok: false, error: t.blocker };

  const [row] = await tx
    .insert(entryCorrection)
    .values({ tenantId, entryId: t.entryId, kind: t.kind, reason, requestedBy: actor.userId, requestedOn: await businessDate(ctx), submitKey: input.submitKey })
    .returning({ id: entryCorrection.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "correction.request",
    entityType: "journal_entry",
    entityId: t.entryId,
    after: { correctionId: row!.id, kind: t.kind, entryNo: t.entryNo, amount: t.total.toString(), reason },
    device: actor.device,
  });
  return { ok: true, correctionId: row!.id, replayed: false };
}

async function lockPending({ tx, tenantId }: TenantTx, correctionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(correctionId)) return undefined;
  const [row] = await tx
    .select()
    .from(entryCorrection)
    .where(and(eq(entryCorrection.tenantId, tenantId), eq(entryCorrection.id, correctionId)))
    .for("update");
  return row;
}

/** A different managing officer approves: the original entry is reversed today. */
export async function approveCorrection(
  ctx: TenantTx,
  d: { correctionId: string; note?: string } & Actor,
): Promise<{ ok: true; entryNo: bigint } | { ok: false; error: CorrectionError }> {
  const { tx, tenantId } = ctx;
  const c = await lockPending(ctx, d.correctionId);
  if (!c) return { ok: false, error: "not_found" };
  if (c.status !== "pending") return { ok: false, error: "wrong_status" };
  if (c.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  const first = await correctionTarget(ctx, c.entryId);
  if (!first) return { ok: false, error: "not_found" };
  await lockFor(ctx, first);
  const t = (await correctionTarget(ctx, c.entryId))!;
  if (t.blocker && t.blocker !== "already_pending") return { ok: false, error: t.blocker };

  const posted = await reverseEntry(ctx, {
    entryId: c.entryId,
    reason: `Correction: ${c.reason}`,
    createdBy: d.userId,
    idempotencyKey: `correction:${c.id}`,
    device: d.device,
  });
  const note = d.note?.trim().slice(0, 1000) || null;
  await tx
    .update(entryCorrection)
    .set({ status: "approved", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note, reversalId: posted.entry.id })
    .where(and(eq(entryCorrection.tenantId, tenantId), eq(entryCorrection.id, c.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "correction.approve",
    entityType: "journal_entry",
    entityId: c.entryId,
    after: { correctionId: c.id, kind: c.kind, entryNo: t.entryNo, reversalNo: posted.entry.entryNo },
    device: d.device,
  });
  return { ok: true, entryNo: posted.entry.entryNo };
}

/** Turned down by a different officer, with a reason; the transaction stands. */
export async function rejectCorrection(ctx: TenantTx, d: { correctionId: string; note: string } & Actor): Promise<{ ok: true } | { ok: false; error: CorrectionError }> {
  const c = await lockPending(ctx, d.correctionId);
  if (!c) return { ok: false, error: "not_found" };
  if (c.status !== "pending") return { ok: false, error: "wrong_status" };
  if (c.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  const note = d.note.trim().slice(0, 1000);
  if (!note) return { ok: false, error: "note_required" };
  await ctx.tx
    .update(entryCorrection)
    .set({ status: "rejected", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note })
    .where(and(eq(entryCorrection.tenantId, ctx.tenantId), eq(entryCorrection.id, c.id)));
  await recordAudit(ctx, { actorUserId: d.userId, action: "correction.reject", entityType: "journal_entry", entityId: c.entryId, after: { correctionId: c.id, note }, device: d.device });
  return { ok: true };
}

/** The officer who asked can take it back while it waits. */
export async function cancelCorrection(ctx: TenantTx, d: { correctionId: string } & Actor): Promise<{ ok: true } | { ok: false; error: CorrectionError }> {
  const c = await lockPending(ctx, d.correctionId);
  if (!c) return { ok: false, error: "not_found" };
  if (c.status !== "pending") return { ok: false, error: "wrong_status" };
  if (c.requestedBy !== d.userId) return { ok: false, error: "not_requester" };
  await ctx.tx
    .update(entryCorrection)
    .set({ status: "cancelled", decidedBy: d.userId, decidedAt: sql`now()` })
    .where(and(eq(entryCorrection.tenantId, ctx.tenantId), eq(entryCorrection.id, c.id)));
  await recordAudit(ctx, { actorUserId: d.userId, action: "correction.cancel", entityType: "journal_entry", entityId: c.entryId, after: { correctionId: c.id }, device: d.device });
  return { ok: true };
}

export interface CorrectionView {
  id: string;
  entryId: string;
  kind: CorrectionKind;
  status: CorrectionStatus;
  reason: string;
  requestedOn: string;
  requestedBy: { id: string; nameEn: string | null; nameBn: string | null };
  decidedBy: { nameEn: string | null; nameBn: string | null } | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  entryNo: bigint;
  entryDate: string;
  total: bigint;
  member: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null } | null;
  reversalNo: bigint | null;
}

const asker = alias(appUser, "asker");
const decider = alias(appUser, "decider");

/** Corrections, pending first then newest, optionally for one entry. */
export async function listCorrections(
  { tx, tenantId }: TenantTx,
  opts: { entryId?: string; status?: CorrectionStatus; limit?: number } = {},
): Promise<CorrectionView[]> {
  const rows = await tx
    .select({
      id: entryCorrection.id,
      entryId: entryCorrection.entryId,
      kind: entryCorrection.kind,
      status: entryCorrection.status,
      reason: entryCorrection.reason,
      requestedOn: entryCorrection.requestedOn,
      askerId: asker.id,
      askerEn: asker.nameEn,
      askerBn: asker.nameBn,
      deciderEn: decider.nameEn,
      deciderBn: decider.nameBn,
      decidedAt: entryCorrection.decidedAt,
      decisionNote: entryCorrection.decisionNote,
      entryNo: sql<string>`(select je.entry_no from journal_entry je where je.tenant_id = ${entryCorrection.tenantId} and je.id = ${entryCorrection.entryId})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
      entryDate: sql<string>`(select je.business_date::text from journal_entry je where je.tenant_id = ${entryCorrection.tenantId} and je.id = ${entryCorrection.entryId})`,
      total: sql<string>`(select coalesce(sum(jl.debit), 0) from journal_line jl where jl.tenant_id = ${entryCorrection.tenantId} and jl.entry_id = ${entryCorrection.entryId})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
      memberId: sql<string | null>`(select jl.member_id from journal_line jl where jl.tenant_id = ${entryCorrection.tenantId} and jl.entry_id = ${entryCorrection.entryId} and jl.member_id is not null limit 1)`,
      reversalNo: sql<string | null>`(select je.entry_no from journal_entry je where je.tenant_id = ${entryCorrection.tenantId} and je.id = ${entryCorrection.reversalId})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
    })
    .from(entryCorrection)
    .innerJoin(asker, and(eq(asker.tenantId, entryCorrection.tenantId), eq(asker.id, entryCorrection.requestedBy)))
    .leftJoin(decider, and(eq(decider.tenantId, entryCorrection.tenantId), eq(decider.id, entryCorrection.decidedBy)))
    .where(
      and(
        eq(entryCorrection.tenantId, tenantId),
        opts.entryId ? eq(entryCorrection.entryId, opts.entryId) : undefined,
        opts.status ? eq(entryCorrection.status, opts.status) : undefined,
      ),
    )
    .orderBy(sql`${entryCorrection.status} = 'pending' desc`, desc(entryCorrection.createdAt))
    .limit(opts.limit ?? 50);
  const ids = [...new Set(rows.map((r) => r.memberId).filter((x): x is string => !!x))];
  const members = ids.length
    ? await tx
        .select({ id: member.id, memberNo: member.memberNo, nameEn: member.nameEn, nameBn: member.nameBn })
        .from(member)
        .where(and(eq(member.tenantId, tenantId), inArray(member.id, ids)))
    : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  return rows.map((r) => ({
    id: r.id,
    entryId: r.entryId,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    requestedOn: r.requestedOn,
    requestedBy: { id: r.askerId, nameEn: r.askerEn, nameBn: r.askerBn },
    decidedBy: r.decidedAt && r.status !== "cancelled" ? { nameEn: r.deciderEn, nameBn: r.deciderBn } : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    entryNo: r.entryNo as bigint,
    entryDate: r.entryDate,
    total: r.total as bigint,
    member: r.memberId ? (byId.get(r.memberId) ?? null) : null,
    reversalNo: r.reversalNo as bigint | null,
  }));
}

/** Corrections waiting on someone other than this user, for nav badges and callouts. */
export async function pendingCorrectionsFor({ tx, tenantId }: TenantTx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(entryCorrection)
    .where(and(eq(entryCorrection.tenantId, tenantId), eq(entryCorrection.status, "pending"), ne(entryCorrection.requestedBy, userId)));
  return row?.n ?? 0;
}
