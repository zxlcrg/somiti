import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, savingsAccount, savingsProduct, savingsTransaction, savingsWithdrawal } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, LedgerError, postEntry } from "@/modules/ledger";
import { DEPOSIT_METHODS, getAccount, MAX_DEPOSIT, type DepositMethod } from "./accounts";

/*
 * Withdrawals are money going out, so they take two people (architecture
 * doc, "Security and controls"): one officer enters the request, a
 * different one approves it, and only then is anything posted or paid.
 * Requests and approvals on one account take turns, so two requests can't
 * together promise more than the balance.
 */

export type WithdrawalStatus = "pending" | "approved" | "rejected" | "cancelled";
export const MAX_REASON = 300;

const ACCOUNT_FOR: Record<DepositMethod, "cash_in_hand" | "bank" | "mobile_wallet"> = {
  cash: "cash_in_hand",
  bank: "bank",
  mobile_wallet: "mobile_wallet",
};

async function lockAccount({ tx, tenantId }: TenantTx, accountId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`savings_withdrawal:${tenantId}:${accountId}`}))`);
}

/** Balance less what pending requests have already promised. */
async function available(ctx: TenantTx, accountId: string, balance: bigint, exceptId?: string): Promise<bigint> {
  const [row] = await ctx.tx
    .select({ held: sql<string>`coalesce(sum(${savingsWithdrawal.amount}), 0)` })
    .from(savingsWithdrawal)
    .where(
      and(
        eq(savingsWithdrawal.tenantId, ctx.tenantId),
        eq(savingsWithdrawal.accountId, accountId),
        eq(savingsWithdrawal.status, "pending"),
        exceptId ? ne(savingsWithdrawal.id, exceptId) : undefined,
      ),
    );
  return balance - BigInt(row?.held ?? 0);
}

// ---------- Requesting ----------

export interface WithdrawalInput {
  accountId: string;
  /** Typed taka; Bangla digits are fine. */
  amount: string;
  method: string;
  paymentRef?: string;
  reason?: string;
  /** Generated once per form, so a double submit makes one request. */
  submitKey: string;
}

export type WithdrawalError =
  | "invalid_amount"
  | "too_large"
  | "over_balance"
  | "invalid_method"
  | "ref_required"
  | "ref_too_long"
  | "reason_too_long"
  | "account_closed"
  | "not_found";

export type WithdrawalRequestResult =
  | { ok: true; withdrawalId: string; replayed: boolean }
  | { ok: false; errors: Partial<Record<"amount" | "method" | "paymentRef" | "reason" | "form", WithdrawalError>>; available?: bigint };

export async function requestWithdrawal(
  ctx: TenantTx,
  input: WithdrawalInput,
  actor: { userId: string; device?: string },
): Promise<WithdrawalRequestResult> {
  const errors: Partial<Record<"amount" | "method" | "paymentRef" | "reason" | "form", WithdrawalError>> = {};
  const amount = parseTaka(input.amount);
  if (amount === null || amount <= 0n) errors.amount = "invalid_amount";
  else if (amount > MAX_DEPOSIT) errors.amount = "too_large";
  const method = DEPOSIT_METHODS.find((m) => m === input.method);
  if (!method) errors.method = "invalid_method";
  const paymentRef = input.paymentRef?.trim() || null;
  if (method === "mobile_wallet" && !paymentRef) errors.paymentRef = "ref_required";
  if (paymentRef && paymentRef.length > 64) errors.paymentRef = "ref_too_long";
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > MAX_REASON) errors.reason = "reason_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  const { tx, tenantId } = ctx;
  await lockAccount(ctx, input.accountId);
  const [prior] = await tx
    .select({ id: savingsWithdrawal.id, requestedBy: savingsWithdrawal.requestedBy, accountId: savingsWithdrawal.accountId })
    .from(savingsWithdrawal)
    .where(and(eq(savingsWithdrawal.tenantId, tenantId), eq(savingsWithdrawal.submitKey, input.submitKey)));
  if (prior) {
    if (prior.requestedBy !== actor.userId || prior.accountId !== input.accountId) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "This submit key was already used");
    }
    return { ok: true, withdrawalId: prior.id, replayed: true };
  }
  const account = await getAccount(ctx, input.accountId);
  if (!account) return { ok: false, errors: { form: "not_found" } };
  if (account.status !== "active") return { ok: false, errors: { form: "account_closed" } };
  const free = await available(ctx, account.id, account.balance);
  if (amount! > free) return { ok: false, errors: { amount: "over_balance" }, available: free > 0n ? free : 0n };

  const [row] = await tx
    .insert(savingsWithdrawal)
    .values({
      tenantId,
      accountId: account.id,
      amount: amount!,
      paymentMethod: method!,
      paymentRef,
      reason,
      requestedBy: actor.userId,
      submitKey: input.submitKey,
    })
    .returning({ id: savingsWithdrawal.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "savings.withdrawal.request",
    entityType: "savings_withdrawal",
    entityId: row!.id,
    after: { accountId: account.id, amount: amount!.toString(), paymentMethod: method, paymentRef, reason },
    device: actor.device,
  });
  return { ok: true, withdrawalId: row!.id, replayed: false };
}

// ---------- Deciding ----------

export type DecisionError = "not_found" | "decided" | "self_decision" | "not_maker" | "note_required" | "over_balance" | "account_closed";
export type DecisionResult = { ok: true; entryNo?: bigint } | { ok: false; error: DecisionError };

interface Decision {
  withdrawalId: string;
  userId: string;
  device?: string;
}

/** Takes the account's turn, then locks the request row until commit. */
async function lockPending(ctx: TenantTx, id: string) {
  const where = and(eq(savingsWithdrawal.tenantId, ctx.tenantId), eq(savingsWithdrawal.id, id));
  const [found] = await ctx.tx.select({ accountId: savingsWithdrawal.accountId }).from(savingsWithdrawal).where(where);
  if (!found) return undefined;
  await lockAccount(ctx, found.accountId);
  const [row] = await ctx.tx.select().from(savingsWithdrawal).where(where).for("update");
  return row;
}

/**
 * Approves a withdrawal and posts it on the current business date:
 * Dr Member savings (on the member's line), Cr cash in hand, bank or
 * wallet. The balance is checked again, in turn with other requests,
 * because deposits may have been reversed since the request.
 */
export async function approveWithdrawal(ctx: TenantTx, d: Decision): Promise<DecisionResult> {
  const w = await lockPending(ctx, d.withdrawalId);
  if (!w) return { ok: false, error: "not_found" };
  if (w.status !== "pending") return { ok: false, error: "decided" };
  if (w.requestedBy === d.userId) return { ok: false, error: "self_decision" };

  const { tx, tenantId } = ctx;
  const [account] = await tx
    .select({
      accountNo: savingsAccount.accountNo,
      status: savingsAccount.status,
      memberId: savingsAccount.memberId,
      memberNo: member.memberNo,
      branchId: member.branchId,
      productCode: savingsProduct.code,
    })
    .from(savingsAccount)
    .innerJoin(member, and(eq(member.tenantId, savingsAccount.tenantId), eq(member.id, savingsAccount.memberId)))
    .innerJoin(savingsProduct, and(eq(savingsProduct.tenantId, savingsAccount.tenantId), eq(savingsProduct.id, savingsAccount.productId)))
    .where(and(eq(savingsAccount.tenantId, tenantId), eq(savingsAccount.id, w.accountId)));
  if (!account) return { ok: false, error: "not_found" };
  if (account.status !== "active") return { ok: false, error: "account_closed" };
  const view = await getAccount(ctx, w.accountId);
  if (w.amount > (await available(ctx, w.accountId, view!.balance, w.id))) return { ok: false, error: "over_balance" };

  const creditKey = ACCOUNT_FOR[w.paymentMethod];
  const accounts = await accountIdsByKey(ctx, ["member_savings", creditKey] as const);
  const posted = await postEntry(ctx, {
    branchId: account.branchId,
    source: "savings_withdrawal",
    narration: `Savings withdrawal: ${account.productCode} account #${account.accountNo}, member #${account.memberNo}${w.paymentRef ? `, ref ${w.paymentRef}` : ""}`,
    createdBy: w.requestedBy,
    idempotencyKey: `savings_withdrawal:${w.id}`,
    device: d.device,
    lines: [
      { accountId: accounts.member_savings, debit: w.amount, memberId: account.memberId },
      { accountId: accounts[creditKey], credit: w.amount },
    ],
  });
  await tx.insert(savingsTransaction).values({
    tenantId,
    accountId: w.accountId,
    kind: "withdrawal",
    amount: w.amount,
    channel: "office",
    paymentMethod: w.paymentMethod,
    paymentRef: w.paymentRef,
    journalEntryId: posted.entry.id,
    businessDate: posted.entry.businessDate,
    createdBy: w.requestedBy,
  });
  await tx
    .update(savingsWithdrawal)
    .set({ status: "approved", decidedBy: d.userId, decidedAt: sql`now()`, entryId: posted.entry.id })
    .where(and(eq(savingsWithdrawal.tenantId, tenantId), eq(savingsWithdrawal.id, w.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "savings.withdrawal.approve",
    entityType: "savings_withdrawal",
    entityId: w.id,
    after: { entryNo: posted.entry.entryNo, businessDate: posted.entry.businessDate, amount: w.amount.toString() },
    device: d.device,
  });
  return { ok: true, entryNo: posted.entry.entryNo };
}

/** Rejects a request with a reason. Nothing is posted. */
export async function rejectWithdrawal(ctx: TenantTx, d: Decision & { note: string }): Promise<DecisionResult> {
  const note = d.note.trim();
  if (!note) return { ok: false, error: "note_required" };
  return decide(ctx, d, "rejected", note.slice(0, 1000));
}

/** The person who entered a request takes it back. */
export async function cancelWithdrawal(ctx: TenantTx, d: Decision & { note?: string }): Promise<DecisionResult> {
  return decide(ctx, d, "cancelled", d.note?.trim().slice(0, 1000) || null);
}

async function decide(ctx: TenantTx, d: Decision, status: "rejected" | "cancelled", note: string | null): Promise<DecisionResult> {
  const w = await lockPending(ctx, d.withdrawalId);
  if (!w) return { ok: false, error: "not_found" };
  if (w.status !== "pending") return { ok: false, error: "decided" };
  if (status === "rejected" && w.requestedBy === d.userId) return { ok: false, error: "self_decision" };
  if (status === "cancelled" && w.requestedBy !== d.userId) return { ok: false, error: "not_maker" };
  await ctx.tx
    .update(savingsWithdrawal)
    .set({ status, decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note })
    .where(and(eq(savingsWithdrawal.tenantId, ctx.tenantId), eq(savingsWithdrawal.id, w.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: status === "rejected" ? "savings.withdrawal.reject" : "savings.withdrawal.cancel",
    entityType: "savings_withdrawal",
    entityId: w.id,
    after: { note },
    device: d.device,
  });
  return { ok: true };
}

// ---------- Reading ----------

export interface WithdrawalView {
  id: string;
  accountId: string;
  accountNo: number;
  productCode: string;
  memberId: string;
  memberNo: number;
  memberNameEn: string | null;
  memberNameBn: string | null;
  amount: bigint;
  paymentMethod: DepositMethod;
  paymentRef: string | null;
  reason: string | null;
  status: WithdrawalStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  requestedBy: { id: string; nameEn: string | null; nameBn: string | null };
  decidedBy: { id: string; nameEn: string | null; nameBn: string | null } | null;
  /** Payment number once approved. */
  entryNo: bigint | null;
}

function userName(col: "requested_by" | "decided_by", lang: "en" | "bn") {
  return sql<string | null>`(select u.name_${sql.raw(lang)} from app_user u where u.tenant_id = "savings_withdrawal"."tenant_id" and u.id = "savings_withdrawal".${sql.raw(`"${col}"`)})`;
}

export async function listWithdrawals(
  ctx: TenantTx,
  filter: { status?: WithdrawalStatus | WithdrawalStatus[]; accountId?: string; id?: string; limit?: number } = {},
): Promise<WithdrawalView[]> {
  const { tx, tenantId } = ctx;
  const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
  const rows = await tx
    .select({
      id: savingsWithdrawal.id,
      accountId: savingsWithdrawal.accountId,
      accountNo: savingsAccount.accountNo,
      productCode: savingsProduct.code,
      memberId: member.id,
      memberNo: member.memberNo,
      memberNameEn: member.nameEn,
      memberNameBn: member.nameBn,
      amount: savingsWithdrawal.amount,
      paymentMethod: savingsWithdrawal.paymentMethod,
      paymentRef: savingsWithdrawal.paymentRef,
      reason: savingsWithdrawal.reason,
      status: savingsWithdrawal.status,
      createdAt: savingsWithdrawal.createdAt,
      decidedAt: savingsWithdrawal.decidedAt,
      decisionNote: savingsWithdrawal.decisionNote,
      requestedById: savingsWithdrawal.requestedBy,
      requestedEn: userName("requested_by", "en"),
      requestedBn: userName("requested_by", "bn"),
      decidedById: savingsWithdrawal.decidedBy,
      decidedEn: userName("decided_by", "en"),
      decidedBn: userName("decided_by", "bn"),
      entryNo: sql<string | null>`(
        select je.entry_no from journal_entry je
         where je.tenant_id = "savings_withdrawal"."tenant_id" and je.id = "savings_withdrawal"."entry_id"
      )`,
    })
    .from(savingsWithdrawal)
    .innerJoin(savingsAccount, and(eq(savingsAccount.tenantId, savingsWithdrawal.tenantId), eq(savingsAccount.id, savingsWithdrawal.accountId)))
    .innerJoin(savingsProduct, and(eq(savingsProduct.tenantId, savingsAccount.tenantId), eq(savingsProduct.id, savingsAccount.productId)))
    .innerJoin(member, and(eq(member.tenantId, savingsAccount.tenantId), eq(member.id, savingsAccount.memberId)))
    .where(
      and(
        eq(savingsWithdrawal.tenantId, tenantId),
        statuses ? inArray(savingsWithdrawal.status, statuses) : undefined,
        filter.accountId ? eq(savingsWithdrawal.accountId, filter.accountId) : undefined,
        filter.id ? eq(savingsWithdrawal.id, filter.id) : undefined,
      ),
    )
    .orderBy(desc(savingsWithdrawal.createdAt))
    .limit(filter.limit ?? 50);
  return rows.map(({ requestedById, requestedEn, requestedBn, decidedById, decidedEn, decidedBn, entryNo, ...r }) => ({
    ...r,
    requestedBy: { id: requestedById, nameEn: requestedEn, nameBn: requestedBn },
    decidedBy: decidedById ? { id: decidedById, nameEn: decidedEn, nameBn: decidedBn } : null,
    entryNo: entryNo === null ? null : BigInt(entryNo),
  }));
}

export async function getWithdrawal(ctx: TenantTx, id: string): Promise<WithdrawalView | null> {
  const [row] = await listWithdrawals(ctx, { id, limit: 1 });
  return row ?? null;
}

/** Requests someone else entered, so this user could decide them. */
export async function withdrawalsForChecker(ctx: TenantTx, userId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(savingsWithdrawal)
    .where(
      and(
        eq(savingsWithdrawal.tenantId, ctx.tenantId),
        eq(savingsWithdrawal.status, "pending"),
        ne(savingsWithdrawal.requestedBy, userId),
      ),
    );
  return row?.n ?? 0;
}
