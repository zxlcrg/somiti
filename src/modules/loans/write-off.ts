import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { TenantTx } from "@/db/client";
import { appUser, loan, loanProduct, loanWriteOff, member, tenant } from "@/db/schema";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, ensureChartAccount, postEntry } from "@/modules/ledger";
import { outstanding } from "./allocate";
import { scheduleState } from "./loans";

/*
 * Writing off a loan nobody expects to be repaid (architecture review:
 * write-off with approval). One managing officer asks with a reason; a
 * different one approves. Approval posts Dr bad debts written off, Cr loans
 * receivable for the principal still owed that day, and the loan becomes
 * written_off: it leaves the overdue list, the collection sheet and the
 * dashboard's money out, and its guarantors are free to leave. Service
 * charge still owed was never income (cash basis), so nothing posts for it;
 * it is kept on the record for the books.
 */

export const MAX_WRITE_OFF_REASON = 300;

type Actor = { userId: string; device?: string };

export type WriteOffStatus = "pending" | "approved" | "rejected" | "cancelled";

export type WriteOffError =
  | "not_found"
  | "not_running"
  | "nothing_owed"
  | "already_pending"
  | "reason_required"
  | "reason_too_long"
  | "wrong_status"
  | "self_decision"
  | "note_required"
  | "not_requester";

async function lockRunningLoan({ tx, tenantId }: TenantTx, loanId: string) {
  const [row] = await tx
    .select()
    .from(loan)
    .where(and(eq(loan.tenantId, tenantId), eq(loan.id, loanId)))
    .for("update");
  return row;
}

async function businessDate({ tx, tenantId }: TenantTx): Promise<string> {
  const [row] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  return row!.d;
}

/** Asks to write a running loan off. Nothing posts until a different officer approves. */
export async function requestWriteOff(
  ctx: TenantTx,
  input: { loanId: string; reason: string; submitKey: string },
  actor: Actor,
): Promise<{ ok: true; writeOffId: string; replayed: boolean } | { ok: false; error: WriteOffError }> {
  const { tx, tenantId } = ctx;
  const [earlier] = await tx
    .select({ id: loanWriteOff.id, loanId: loanWriteOff.loanId })
    .from(loanWriteOff)
    .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.submitKey, input.submitKey)));
  if (earlier?.loanId === input.loanId) return { ok: true, writeOffId: earlier.id, replayed: true };

  const reason = input.reason.trim();
  if (reason.length < 3) return { ok: false, error: "reason_required" };
  if (reason.length > MAX_WRITE_OFF_REASON) return { ok: false, error: "reason_too_long" };
  const l = await lockRunningLoan(ctx, input.loanId);
  if (!l) return { ok: false, error: "not_found" };
  if (l.status !== "disbursed") return { ok: false, error: "not_running" };
  if (outstanding(await scheduleState(ctx, l.id)).principal <= 0n) return { ok: false, error: "nothing_owed" };
  const [pending] = await tx
    .select({ id: loanWriteOff.id })
    .from(loanWriteOff)
    .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.loanId, l.id), eq(loanWriteOff.status, "pending")));
  if (pending) return { ok: false, error: "already_pending" };

  const [row] = await tx
    .insert(loanWriteOff)
    .values({ tenantId, loanId: l.id, reason, requestedBy: actor.userId, requestedOn: await businessDate(ctx), submitKey: input.submitKey })
    .returning({ id: loanWriteOff.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "loan.write_off.request",
    entityType: "loan",
    entityId: l.id,
    after: { loanNo: l.loanNo, writeOffId: row!.id, reason },
    device: actor.device,
  });
  return { ok: true, writeOffId: row!.id, replayed: false };
}

async function lockPending({ tx, tenantId }: TenantTx, writeOffId: string) {
  const [row] = await tx
    .select()
    .from(loanWriteOff)
    .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.id, writeOffId)))
    .for("update");
  return row;
}

/** A different managing officer approves: the principal still owed goes to bad debts. */
export async function approveWriteOff(
  ctx: TenantTx,
  d: { writeOffId: string; note?: string } & Actor,
): Promise<{ ok: true; principal: bigint; charge: bigint; entryNo: bigint } | { ok: false; error: WriteOffError }> {
  const { tx, tenantId } = ctx;
  const w = await lockPending(ctx, d.writeOffId);
  if (!w) return { ok: false, error: "not_found" };
  if (w.status !== "pending") return { ok: false, error: "wrong_status" };
  if (w.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  const l = await lockRunningLoan(ctx, w.loanId);
  if (!l || l.status !== "disbursed") return { ok: false, error: "not_running" };
  const left = outstanding(await scheduleState(ctx, l.id));
  if (left.principal <= 0n) return { ok: false, error: "nothing_owed" };

  const [owner] = await tx
    .select({ branchId: member.branchId, memberNo: member.memberNo, code: loanProduct.code })
    .from(member)
    .innerJoin(loanProduct, and(eq(loanProduct.tenantId, member.tenantId), eq(loanProduct.id, l.productId)))
    .where(and(eq(member.tenantId, tenantId), eq(member.id, l.memberId)));
  await ensureChartAccount(ctx, "bad_debt_expense");
  const acc = await accountIdsByKey(ctx, ["loans_receivable", "bad_debt_expense"] as const);
  const posted = await postEntry(ctx, {
    branchId: owner!.branchId,
    source: "loan_write_off",
    narration: `Loan written off: ${owner!.code} loan #${l.loanNo}, member #${owner!.memberNo}`,
    createdBy: d.userId,
    idempotencyKey: `loan_write_off:${w.id}`,
    device: d.device,
    lines: [
      { accountId: acc.bad_debt_expense, debit: left.principal, memberId: l.memberId },
      { accountId: acc.loans_receivable, credit: left.principal, memberId: l.memberId },
    ],
  });
  const note = d.note?.trim().slice(0, 1000) || null;
  await tx
    .update(loanWriteOff)
    .set({ status: "approved", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note, principal: left.principal, charge: left.interest, entryId: posted.entry.id })
    .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.id, w.id)));
  await tx.update(loan).set({ status: "written_off" }).where(and(eq(loan.tenantId, tenantId), eq(loan.id, l.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "loan.write_off.approve",
    entityType: "loan",
    entityId: l.id,
    after: { loanNo: l.loanNo, writeOffId: w.id, entryNo: posted.entry.entryNo, principal: left.principal.toString(), charge: left.interest.toString() },
    device: d.device,
  });
  return { ok: true, principal: left.principal, charge: left.interest, entryNo: posted.entry.entryNo };
}

/** Turned down by a different officer, with a reason; the loan carries on. */
export async function rejectWriteOff(ctx: TenantTx, d: { writeOffId: string; note: string } & Actor): Promise<{ ok: true } | { ok: false; error: WriteOffError }> {
  const w = await lockPending(ctx, d.writeOffId);
  if (!w) return { ok: false, error: "not_found" };
  if (w.status !== "pending") return { ok: false, error: "wrong_status" };
  if (w.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  const note = d.note.trim().slice(0, 1000);
  if (!note) return { ok: false, error: "note_required" };
  await ctx.tx
    .update(loanWriteOff)
    .set({ status: "rejected", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note })
    .where(and(eq(loanWriteOff.tenantId, ctx.tenantId), eq(loanWriteOff.id, w.id)));
  await recordAudit(ctx, { actorUserId: d.userId, action: "loan.write_off.reject", entityType: "loan", entityId: w.loanId, after: { writeOffId: w.id, note }, device: d.device });
  return { ok: true };
}

/** The officer who asked can take it back while it waits. */
export async function cancelWriteOff(ctx: TenantTx, d: { writeOffId: string } & Actor): Promise<{ ok: true } | { ok: false; error: WriteOffError }> {
  const w = await lockPending(ctx, d.writeOffId);
  if (!w) return { ok: false, error: "not_found" };
  if (w.status !== "pending") return { ok: false, error: "wrong_status" };
  if (w.requestedBy !== d.userId) return { ok: false, error: "not_requester" };
  await ctx.tx
    .update(loanWriteOff)
    .set({ status: "cancelled", decidedBy: d.userId, decidedAt: sql`now()` })
    .where(and(eq(loanWriteOff.tenantId, ctx.tenantId), eq(loanWriteOff.id, w.id)));
  await recordAudit(ctx, { actorUserId: d.userId, action: "loan.write_off.cancel", entityType: "loan", entityId: w.loanId, after: { writeOffId: w.id }, device: d.device });
  return { ok: true };
}

export interface WriteOffView {
  id: string;
  status: WriteOffStatus;
  reason: string;
  requestedOn: string;
  requestedBy: { id: string; nameEn: string | null; nameBn: string | null };
  decidedBy: { nameEn: string | null; nameBn: string | null } | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  principal: bigint | null;
  charge: bigint | null;
  entryNo: bigint | null;
  /** Business date of the write-off entry. */
  writtenOn: string | null;
}

const asker = alias(appUser, "asker");
const decider = alias(appUser, "decider");

/** Every write-off request on a loan, newest first. */
export async function loanWriteOffs({ tx, tenantId }: TenantTx, loanId: string): Promise<WriteOffView[]> {
  const rows = await tx
    .select({
      id: loanWriteOff.id,
      status: loanWriteOff.status,
      reason: loanWriteOff.reason,
      requestedOn: loanWriteOff.requestedOn,
      askerId: asker.id,
      askerEn: asker.nameEn,
      askerBn: asker.nameBn,
      deciderEn: decider.nameEn,
      deciderBn: decider.nameBn,
      decidedAt: loanWriteOff.decidedAt,
      decisionNote: loanWriteOff.decisionNote,
      principal: loanWriteOff.principal,
      charge: loanWriteOff.charge,
      writtenOn: sql<string | null>`(select je.business_date::text from journal_entry je where je.tenant_id = ${loanWriteOff.tenantId} and je.id = ${loanWriteOff.entryId})`,
      entryNo: sql<string | null>`(select je.entry_no from journal_entry je where je.tenant_id = ${loanWriteOff.tenantId} and je.id = ${loanWriteOff.entryId})`.mapWith(
        (v: string | number) => BigInt(v),
      ),
    })
    .from(loanWriteOff)
    .innerJoin(asker, and(eq(asker.tenantId, loanWriteOff.tenantId), eq(asker.id, loanWriteOff.requestedBy)))
    .leftJoin(decider, and(eq(decider.tenantId, loanWriteOff.tenantId), eq(decider.id, loanWriteOff.decidedBy)))
    .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.loanId, loanId)))
    .orderBy(desc(loanWriteOff.createdAt));
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    reason: r.reason,
    requestedOn: r.requestedOn,
    requestedBy: { id: r.askerId, nameEn: r.askerEn, nameBn: r.askerBn },
    decidedBy: r.decidedAt && r.status !== "cancelled" ? { nameEn: r.deciderEn, nameBn: r.deciderBn } : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    principal: r.principal,
    charge: r.charge,
    entryNo: r.entryNo as bigint | null,
    writtenOn: r.writtenOn,
  }));
}

/** Write-offs waiting for a decision, for the loans page. */
export async function pendingWriteOffs({ tx, tenantId }: TenantTx): Promise<{ id: string; loanId: string; requestedBy: string }[]> {
  return tx
    .select({ id: loanWriteOff.id, loanId: loanWriteOff.loanId, requestedBy: loanWriteOff.requestedBy })
    .from(loanWriteOff)
    .where(and(eq(loanWriteOff.tenantId, tenantId), eq(loanWriteOff.status, "pending")));
}
