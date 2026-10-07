import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import {
  member,
  memberExit,
  memberExitPayout,
  savingsAccount,
  savingsTransaction,
  savingsWithdrawal,
  shareTransaction,
} from "@/db/schema";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, postEntry } from "@/modules/ledger";
import { memberAccounts } from "@/modules/savings";
import { PAYMENT_METHODS, shareHolding, type PaymentMethod } from "./shares";

/*
 * A member leaving the somiti (architecture doc: "exit and death
 * settlement"; review: "a member cannot exit with an outstanding loan or an
 * active guarantee"). Exit pays out money, so it takes two officers: one
 * requests, a different one approves, and only approval posts anything.
 *
 * Approval posts one entry for the share refund (Dr Share capital, Cr the
 * payment account) and one per savings account with a balance (Dr Member
 * savings, Cr the payment account; it is also the account's last passbook
 * line), closes the accounts and marks the member exited. Amounts are worked
 * out at approval, since deposits may arrive after the request.
 *
 * Loans arrive in M3; their outstanding-balance and guarantee checks belong
 * in exitBlockers() then.
 */

export const MAX_EXIT_REASON = 500;

/** Who can enter and decide an exit: the officers who manage members (permissions.ts). */
const ACCOUNT_FOR: Record<PaymentMethod, "cash_in_hand" | "bank" | "mobile_wallet"> = {
  cash: "cash_in_hand",
  bank: "bank",
  mobile_wallet: "mobile_wallet",
};

export type ExitStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ExitSettlement {
  shareRefund: bigint;
  shares: number;
  savings: { accountId: string; accountNo: number; productCode: string; balance: bigint }[];
  savingsPayout: bigint;
  total: bigint;
}

/** What leaving would pay out today. */
export async function exitSettlement(ctx: TenantTx, memberId: string): Promise<ExitSettlement> {
  const holding = await shareHolding(ctx, memberId);
  const accounts = (await memberAccounts(ctx, memberId)).filter((a) => a.status === "active");
  const savings = accounts.map((a) => ({ accountId: a.id, accountNo: a.accountNo, productCode: a.productCode, balance: a.balance }));
  const savingsPayout = savings.reduce((sum, a) => sum + (a.balance > 0n ? a.balance : 0n), 0n);
  const shareRefund = holding.amount > 0n ? holding.amount : 0n;
  return { shareRefund, shares: holding.shares, savings, savingsPayout, total: shareRefund + savingsPayout };
}

export type ExitBlocker = "not_active" | "pending_withdrawal" | "negative_balance";

/** Reasons a member can't leave yet. Loans will add theirs here (M3). */
export async function exitBlockers(ctx: TenantTx, memberId: string): Promise<ExitBlocker[]> {
  const { tx, tenantId } = ctx;
  const blockers: ExitBlocker[] = [];
  const [m] = await tx.select({ status: member.status }).from(member).where(and(eq(member.tenantId, tenantId), eq(member.id, memberId)));
  if (m?.status !== "active") blockers.push("not_active");
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(savingsWithdrawal)
    .innerJoin(savingsAccount, and(eq(savingsAccount.tenantId, savingsWithdrawal.tenantId), eq(savingsAccount.id, savingsWithdrawal.accountId)))
    .where(and(eq(savingsWithdrawal.tenantId, tenantId), eq(savingsAccount.memberId, memberId), eq(savingsWithdrawal.status, "pending")));
  if ((pending?.n ?? 0) > 0) blockers.push("pending_withdrawal");
  const accounts = await memberAccounts(ctx, memberId);
  if (accounts.some((a) => a.status === "active" && a.balance < 0n)) blockers.push("negative_balance");
  return blockers;
}

// ---------- Requesting ----------

export interface ExitRequestInput {
  memberId: string;
  reason: string;
  method: string;
  paymentRef?: string;
  /** Generated once per form, so a double submit makes one request. */
  submitKey: string;
}

export type ExitRequestError =
  | "reason_required"
  | "reason_too_long"
  | "invalid_method"
  | "ref_required"
  | "ref_too_long"
  | "already_pending"
  | ExitBlocker
  | "not_found";

export type ExitRequestResult =
  | { ok: true; exitId: string; replayed: boolean }
  | { ok: false; errors: Partial<Record<"reason" | "method" | "paymentRef" | "form", ExitRequestError>>; blockers?: ExitBlocker[] };

async function lockMember({ tx, tenantId }: TenantTx, memberId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, memberId)))
    .for("update");
  return !!row;
}

export async function requestExit(
  ctx: TenantTx,
  input: ExitRequestInput,
  actor: { userId: string; device?: string },
): Promise<ExitRequestResult> {
  const { tx, tenantId } = ctx;
  const [earlier] = await tx
    .select({ id: memberExit.id, memberId: memberExit.memberId })
    .from(memberExit)
    .where(and(eq(memberExit.tenantId, tenantId), eq(memberExit.submitKey, input.submitKey)));
  if (earlier?.memberId === input.memberId) return { ok: true, exitId: earlier.id, replayed: true };

  const errors: Partial<Record<"reason" | "method" | "paymentRef" | "form", ExitRequestError>> = {};
  const reason = input.reason.trim();
  if (!reason) errors.reason = "reason_required";
  else if (reason.length > MAX_EXIT_REASON) errors.reason = "reason_too_long";
  const method = PAYMENT_METHODS.find((m) => m === input.method);
  if (!method) errors.method = "invalid_method";
  const paymentRef = input.paymentRef?.trim() || null;
  if (method === "mobile_wallet" && !paymentRef) errors.paymentRef = "ref_required";
  if (paymentRef && paymentRef.length > 64) errors.paymentRef = "ref_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  if (!(await lockMember(ctx, input.memberId))) return { ok: false, errors: { form: "not_found" } };
  const [open] = await tx
    .select({ id: memberExit.id })
    .from(memberExit)
    .where(and(eq(memberExit.tenantId, tenantId), eq(memberExit.memberId, input.memberId), eq(memberExit.status, "pending")));
  if (open) return { ok: false, errors: { form: "already_pending" } };
  const blockers = await exitBlockers(ctx, input.memberId);
  if (blockers.length) return { ok: false, errors: { form: blockers[0] }, blockers };

  const [row] = await tx
    .insert(memberExit)
    .values({
      tenantId,
      memberId: input.memberId,
      reason,
      paymentMethod: method!,
      paymentRef,
      requestedBy: actor.userId,
      submitKey: input.submitKey,
    })
    .returning({ id: memberExit.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "member.exit.request",
    entityType: "member",
    entityId: input.memberId,
    after: { exitId: row!.id, reason, paymentMethod: method },
    device: actor.device,
  });
  return { ok: true, exitId: row!.id, replayed: false };
}

// ---------- Deciding ----------

export interface ExitDecision {
  exitId: string;
  userId: string;
  device?: string;
}

export type ExitDecisionError = "not_found" | "decided" | "self_decision" | "not_maker" | "note_required" | ExitBlocker;

export type ExitDecisionResult =
  | { ok: true; settlement?: { shareRefund: bigint; savingsPayout: bigint; entryNos: bigint[] } }
  | { ok: false; error: ExitDecisionError; blockers?: ExitBlocker[] };

async function lockExit({ tx, tenantId }: TenantTx, exitId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(exitId)) return undefined;
  const [row] = await tx
    .select()
    .from(memberExit)
    .where(and(eq(memberExit.tenantId, tenantId), eq(memberExit.id, exitId)))
    .for("update");
  return row;
}

/**
 * The second officer approves: pays out shares and savings, closes the
 * accounts and marks the member exited, all in this transaction.
 */
export async function approveExit(ctx: TenantTx, d: ExitDecision): Promise<ExitDecisionResult> {
  const e = await lockExit(ctx, d.exitId);
  if (!e) return { ok: false, error: "not_found" };
  if (e.status !== "pending") return { ok: false, error: "decided" };
  if (e.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  await lockMember(ctx, e.memberId);
  const blockers = (await exitBlockers(ctx, e.memberId)).filter((b) => b !== "not_active");
  if (blockers.length) return { ok: false, error: blockers[0]!, blockers };

  const { tx, tenantId } = ctx;
  const [m] = await tx
    .select({ memberNo: member.memberNo, branchId: member.branchId })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, e.memberId)));
  const settlement = await exitSettlement(ctx, e.memberId);
  const payKey = ACCOUNT_FOR[e.paymentMethod];
  const accounts = await accountIdsByKey(ctx, ["share_capital", "member_savings", payKey] as const);
  const ref = e.paymentRef ? `, ref ${e.paymentRef}` : "";
  const entryNos: bigint[] = [];

  if (settlement.shareRefund > 0n) {
    const posted = await postEntry(ctx, {
      branchId: m!.branchId,
      source: "member_exit",
      narration: `Share capital refunded on exit: member #${m!.memberNo}${ref}`,
      createdBy: e.requestedBy,
      idempotencyKey: `member_exit:${e.id}:shares`,
      device: d.device,
      lines: [
        { accountId: accounts.share_capital, debit: settlement.shareRefund, memberId: e.memberId },
        { accountId: accounts[payKey], credit: settlement.shareRefund },
      ],
    });
    const price = settlement.shares > 0 ? settlement.shareRefund / BigInt(settlement.shares) : settlement.shareRefund;
    await tx.insert(shareTransaction).values({
      tenantId,
      memberId: e.memberId,
      kind: "refund",
      shares: Math.max(1, settlement.shares),
      price: price > 0n ? price : 1n,
      amount: settlement.shareRefund,
      paymentMethod: e.paymentMethod,
      paymentRef: e.paymentRef,
      journalEntryId: posted.entry.id,
      businessDate: posted.entry.businessDate,
      createdBy: e.requestedBy,
    });
    await tx.insert(memberExitPayout).values({
      tenantId,
      exitId: e.id,
      kind: "shares",
      amount: settlement.shareRefund,
      journalEntryId: posted.entry.id,
    });
    entryNos.push(posted.entry.entryNo);
  }

  for (const account of settlement.savings) {
    if (account.balance > 0n) {
      const posted = await postEntry(ctx, {
        branchId: m!.branchId,
        source: "member_exit",
        narration: `Savings paid out on exit: ${account.productCode} account #${account.accountNo}, member #${m!.memberNo}${ref}`,
        createdBy: e.requestedBy,
        idempotencyKey: `member_exit:${e.id}:savings:${account.accountId}`,
        device: d.device,
        lines: [
          { accountId: accounts.member_savings, debit: account.balance, memberId: e.memberId, savingsAccountId: account.accountId },
          { accountId: accounts[payKey], credit: account.balance },
        ],
      });
      await tx.insert(savingsTransaction).values({
        tenantId,
        accountId: account.accountId,
        kind: "withdrawal",
        amount: account.balance,
        channel: "office",
        paymentMethod: e.paymentMethod,
        paymentRef: e.paymentRef,
        journalEntryId: posted.entry.id,
        businessDate: posted.entry.businessDate,
        createdBy: e.requestedBy,
      });
      await tx.insert(memberExitPayout).values({
        tenantId,
        exitId: e.id,
        kind: "savings",
        savingsAccountId: account.accountId,
        amount: account.balance,
        journalEntryId: posted.entry.id,
      });
      entryNos.push(posted.entry.entryNo);
    }
  }

  const accountIds = settlement.savings.map((a) => a.accountId);
  if (accountIds.length) {
    await tx
      .update(savingsAccount)
      .set({ status: "closed" })
      .where(and(eq(savingsAccount.tenantId, tenantId), inArray(savingsAccount.id, accountIds)));
  }
  await tx.update(member).set({ status: "exited" }).where(and(eq(member.tenantId, tenantId), eq(member.id, e.memberId)));
  await tx
    .update(memberExit)
    .set({
      status: "approved",
      decidedBy: d.userId,
      decidedAt: sql`now()`,
      shareRefund: settlement.shareRefund,
      savingsPayout: settlement.savingsPayout,
    })
    .where(and(eq(memberExit.tenantId, tenantId), eq(memberExit.id, e.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "member.exit.approve",
    entityType: "member",
    entityId: e.memberId,
    after: {
      exitId: e.id,
      shareRefund: settlement.shareRefund,
      savingsPayout: settlement.savingsPayout,
      entryNos,
      closedAccounts: accountIds.length,
    },
    device: d.device,
  });
  return { ok: true, settlement: { shareRefund: settlement.shareRefund, savingsPayout: settlement.savingsPayout, entryNos } };
}

/** The second officer turns the request down, with a reason. Nothing is posted. */
export async function rejectExit(ctx: TenantTx, d: ExitDecision & { note: string }): Promise<ExitDecisionResult> {
  const note = d.note.trim();
  if (!note) return { ok: false, error: "note_required" };
  return decide(ctx, d, "rejected", note.slice(0, 1000));
}

/** The officer who entered the request takes it back. */
export async function cancelExit(ctx: TenantTx, d: ExitDecision & { note?: string }): Promise<ExitDecisionResult> {
  return decide(ctx, d, "cancelled", d.note?.trim().slice(0, 1000) || null);
}

async function decide(ctx: TenantTx, d: ExitDecision, status: "rejected" | "cancelled", note: string | null): Promise<ExitDecisionResult> {
  const e = await lockExit(ctx, d.exitId);
  if (!e) return { ok: false, error: "not_found" };
  if (e.status !== "pending") return { ok: false, error: "decided" };
  if (status === "rejected" && e.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  if (status === "cancelled" && e.requestedBy !== d.userId) return { ok: false, error: "not_maker" };
  await ctx.tx
    .update(memberExit)
    .set({ status, decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note })
    .where(and(eq(memberExit.tenantId, ctx.tenantId), eq(memberExit.id, e.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: status === "rejected" ? "member.exit.reject" : "member.exit.cancel",
    entityType: "member",
    entityId: e.memberId,
    after: { exitId: e.id, note },
    device: d.device,
  });
  return { ok: true };
}

// ---------- Reading ----------

export interface ExitView {
  id: string;
  memberId: string;
  reason: string;
  paymentMethod: PaymentMethod;
  paymentRef: string | null;
  status: ExitStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  shareRefund: bigint | null;
  savingsPayout: bigint | null;
  requestedBy: { id: string; nameEn: string | null; nameBn: string | null };
  decidedBy: { id: string; nameEn: string | null; nameBn: string | null } | null;
  /** Voucher numbers of what approval paid out, oldest first. */
  entryNos: bigint[];
}

function userName(col: "requested_by" | "decided_by", lang: "en" | "bn") {
  return sql<string | null>`(select u.name_${sql.raw(lang)} from app_user u where u.tenant_id = "member_exit"."tenant_id" and u.id = "member_exit".${sql.raw(`"${col}"`)})`;
}

/** The member's exit requests, newest first. */
export async function memberExits({ tx, tenantId }: TenantTx, memberId: string): Promise<ExitView[]> {
  const rows = await tx
    .select({
      id: memberExit.id,
      memberId: memberExit.memberId,
      reason: memberExit.reason,
      paymentMethod: memberExit.paymentMethod,
      paymentRef: memberExit.paymentRef,
      status: memberExit.status,
      createdAt: memberExit.createdAt,
      decidedAt: memberExit.decidedAt,
      decisionNote: memberExit.decisionNote,
      shareRefund: memberExit.shareRefund,
      savingsPayout: memberExit.savingsPayout,
      requestedById: memberExit.requestedBy,
      decidedById: memberExit.decidedBy,
      requestedEn: userName("requested_by", "en"),
      requestedBn: userName("requested_by", "bn"),
      decidedEn: userName("decided_by", "en"),
      decidedBn: userName("decided_by", "bn"),
      // Read through a subquery: only the ledger module touches journal tables in code.
      entryNos: sql<string[] | null>`(
        select array_agg(je.entry_no order by je.entry_no) from member_exit_payout p
          join journal_entry je on je.tenant_id = p.tenant_id and je.id = p.journal_entry_id
         where p.tenant_id = "member_exit"."tenant_id" and p.exit_id = "member_exit"."id"
      )`,
    })
    .from(memberExit)
    .where(and(eq(memberExit.tenantId, tenantId), eq(memberExit.memberId, memberId)))
    .orderBy(desc(memberExit.createdAt));
  return rows.map((r) => ({
    id: r.id,
    memberId: r.memberId,
    reason: r.reason,
    paymentMethod: r.paymentMethod,
    paymentRef: r.paymentRef,
    status: r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    shareRefund: r.shareRefund,
    savingsPayout: r.savingsPayout,
    requestedBy: { id: r.requestedById, nameEn: r.requestedEn, nameBn: r.requestedBn },
    decidedBy: r.decidedById ? { id: r.decidedById, nameEn: r.decidedEn, nameBn: r.decidedBn } : null,
    entryNos: (r.entryNos ?? []).map((n) => BigInt(n)),
  }));
}

/** Exit requests waiting for someone other than this officer to decide. */
export async function exitsForChecker({ tx, tenantId }: TenantTx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberExit)
    .where(and(eq(memberExit.tenantId, tenantId), eq(memberExit.status, "pending"), sql`${memberExit.requestedBy} <> ${userId}`));
  return row?.n ?? 0;
}
