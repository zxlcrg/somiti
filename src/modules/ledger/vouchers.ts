import { randomUUID } from "node:crypto";
import { alias } from "drizzle-orm/pg-core";
import { and, asc, count, desc, eq, gte, inArray, sql, sum } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { appUser, branch, journalEntry, ledgerAccount, tenant, voucher, voucherLine } from "@/db/schema";
import { toLatinDigits } from "@/lib/digits";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { LedgerError } from "./errors";
import { postEntry } from "./service";

/**
 * Manual vouchers with maker-checker (architecture review, "Controls"): one
 * officer prepares a voucher, a different officer approves it, and only the
 * approval posts to the ledger. A person may hold several roles, so the rule
 * compares users, not roles. The database enforces it too
 * (drizzle/0011_*.sql), so the books stay right even if this code is wrong.
 */

export type VoucherStatus = (typeof voucher.$inferSelect)["status"];
export const VOUCHER_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export const MAX_VOUCHER_LINES = 50;

const MAKERS = new Set(["admin", "president", "secretary", "cashier"]);
const CHECKERS = new Set(["admin", "president", "secretary"]);

/** Who may prepare a voucher. */
export function canMakeVouchers(roles: readonly string[]): boolean {
  return roles.some((r) => MAKERS.has(r));
}

/** Who may approve or reject someone else's voucher. */
export function canApproveVouchers(roles: readonly string[]): boolean {
  return roles.some((r) => CHECKERS.has(r));
}

/** Who may read the books: vouchers, cash book and trial balance. */
export function canViewBooks(roles: readonly string[]): boolean {
  return canMakeVouchers(roles);
}

// ---------------------------------------------------------------------------
// The form: strings as typed, checked into a voucher
// ---------------------------------------------------------------------------

export interface VoucherLineForm {
  accountId: string;
  debit: string;
  credit: string;
  memo?: string;
}

export interface VoucherForm {
  narration: string;
  lines: VoucherLineForm[];
}

export type VoucherLineError = "account" | "amount" | "both_sides" | "no_amount" | "memo";
export type VoucherFormError = "narration" | "too_few_lines" | "too_many_lines" | "unbalanced" | "one_account";

export interface VoucherFormErrors {
  form?: VoucherFormError;
  narration?: "required" | "too_long";
  /** By line position, as sent. */
  lines?: Record<number, Partial<Record<"accountId" | "debit" | "credit" | "memo", VoucherLineError>>>;
}

export interface CheckedVoucherLine {
  accountId: string;
  debit?: bigint;
  credit?: bigint;
  memo?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks a voucher as typed. Amounts accept Bangla or Latin digits and
 * grouping commas. Blank lines (no account, no amount) are dropped, so the
 * form can keep a spare empty row.
 */
export function checkVoucherForm(
  form: VoucherForm,
): { ok: true; narration: string; lines: CheckedVoucherLine[]; total: bigint } | { ok: false; errors: VoucherFormErrors } {
  const errors: VoucherFormErrors = {};
  const narration = form.narration.trim();
  if (!narration) errors.narration = "required";
  else if (narration.length > 1000) errors.narration = "too_long";

  const lines: CheckedVoucherLine[] = [];
  const lineErrors: NonNullable<VoucherFormErrors["lines"]> = {};
  form.lines.forEach((raw, i) => {
    const debitText = toLatinDigits(raw.debit ?? "").trim();
    const creditText = toLatinDigits(raw.credit ?? "").trim();
    const memo = (raw.memo ?? "").trim();
    if (!raw.accountId && !debitText && !creditText && !memo) return;

    const e: NonNullable<VoucherFormErrors["lines"]>[number] = {};
    if (!UUID.test(raw.accountId ?? "")) e.accountId = "account";
    const debit = debitText ? parseTaka(debitText) : undefined;
    const credit = creditText ? parseTaka(creditText) : undefined;
    if (debit === null || debit === 0n) e.debit = "amount";
    if (credit === null || credit === 0n) e.credit = "amount";
    if (!e.debit && !e.credit) {
      if (debit && credit) e.credit = "both_sides";
      else if (!debit && !credit) e.debit = "no_amount";
    }
    if (memo.length > 500) e.memo = "memo";
    if (Object.keys(e).length > 0) {
      lineErrors[i] = e;
      return;
    }
    lines.push({ accountId: raw.accountId, debit: debit ?? undefined, credit: credit ?? undefined, memo: memo || undefined });
  });
  if (Object.keys(lineErrors).length > 0) errors.lines = lineErrors;

  const debits = lines.reduce((s, l) => s + (l.debit ?? 0n), 0n);
  const credits = lines.reduce((s, l) => s + (l.credit ?? 0n), 0n);
  if (!errors.lines) {
    if (lines.length < 2) errors.form = "too_few_lines";
    else if (lines.length > MAX_VOUCHER_LINES) errors.form = "too_many_lines";
    else if (debits !== credits) errors.form = "unbalanced";
    else if (new Set(lines.map((l) => l.accountId)).size < 2) errors.form = "one_account";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, narration, lines, total: debits };
}

// ---------------------------------------------------------------------------
// Making, approving, rejecting, cancelling
// ---------------------------------------------------------------------------

export interface SubmitVoucherInput extends VoucherForm {
  branchId: string;
  createdBy: string;
  /** Client-generated; a repeat with the same key returns the first voucher. */
  submitKey?: string;
  device?: string;
}

export type SubmitVoucherResult =
  | { ok: true; voucherId: string; replayed: boolean }
  | { ok: false; errors: VoucherFormErrors };

export async function submitVoucher(ctx: TenantTx, input: SubmitVoucherInput): Promise<SubmitVoucherResult> {
  const checked = checkVoucherForm(input);
  if (!checked.ok) return checked;

  const accountIds = [...new Set(checked.lines.map((l) => l.accountId))];
  const postable = await ctx.tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(
      and(
        eq(ledgerAccount.tenantId, ctx.tenantId),
        inArray(ledgerAccount.id, accountIds),
        eq(ledgerAccount.isPostable, true),
        eq(ledgerAccount.isActive, true),
      ),
    );
  if (postable.length !== accountIds.length) {
    const ok = new Set(postable.map((a) => a.id));
    const lines: NonNullable<VoucherFormErrors["lines"]> = {};
    input.lines.forEach((l, i) => {
      if (l.accountId && !ok.has(l.accountId) && UUID.test(l.accountId)) lines[i] = { accountId: "account" };
    });
    return { ok: false, errors: { lines } };
  }

  const id = randomUUID();
  const inserted = await ctx.tx
    .insert(voucher)
    .values({
      id,
      tenantId: ctx.tenantId,
      branchId: input.branchId,
      narration: checked.narration,
      total: checked.total,
      createdBy: input.createdBy,
      submitKey: input.submitKey,
    })
    .onConflictDoNothing({ target: [voucher.tenantId, voucher.submitKey] })
    .returning({ id: voucher.id });

  if (inserted.length === 0) {
    const [prior] = await ctx.tx
      .select({ id: voucher.id, createdBy: voucher.createdBy })
      .from(voucher)
      .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.submitKey, input.submitKey!)));
    if (!prior || prior.createdBy !== input.createdBy) {
      throw new LedgerError("IDEMPOTENCY_CONFLICT", "This submit key was already used");
    }
    return { ok: true, voucherId: prior.id, replayed: true };
  }

  await ctx.tx.insert(voucherLine).values(
    checked.lines.map((l, i) => ({
      tenantId: ctx.tenantId,
      voucherId: id,
      lineNo: i + 1,
      accountId: l.accountId,
      debit: l.debit ?? 0n,
      credit: l.credit ?? 0n,
      memo: l.memo ?? null,
    })),
  );
  await recordAudit(ctx, {
    actorUserId: input.createdBy,
    action: "voucher.submit",
    entityType: "voucher",
    entityId: id,
    after: { narration: checked.narration, total: checked.total, lines: checked.lines.length },
    device: input.device,
  });
  return { ok: true, voucherId: id, replayed: false };
}

async function lockPending(ctx: TenantTx, voucherId: string) {
  const [row] = await ctx.tx
    .select()
    .from(voucher)
    .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.id, voucherId)))
    .for("update");
  if (!row) throw new LedgerError("NOT_FOUND", "Voucher not found");
  if (row.status !== "pending") throw new LedgerError("VOUCHER_DECIDED", `Voucher is already ${row.status}`);
  return row;
}

interface Decision {
  voucherId: string;
  userId: string;
  device?: string;
}

/**
 * Approves a voucher and posts it, on the current business date, as one
 * journal entry. The voucher row stays locked until commit, so two officers
 * approving at once post it only once.
 */
export async function approveVoucher(ctx: TenantTx, d: Decision): Promise<{ entryId: string; entryNo: bigint }> {
  const v = await lockPending(ctx, d.voucherId);
  if (v.createdBy === d.userId) {
    throw new LedgerError("SELF_APPROVAL", "A voucher must be approved by someone other than its maker");
  }
  const lines = await ctx.tx
    .select()
    .from(voucherLine)
    .where(and(eq(voucherLine.tenantId, ctx.tenantId), eq(voucherLine.voucherId, v.id)))
    .orderBy(asc(voucherLine.lineNo));

  const posted = await postEntry(ctx, {
    branchId: v.branchId,
    source: "manual_voucher",
    narration: v.narration,
    createdBy: v.createdBy,
    idempotencyKey: `voucher:${v.id}`,
    device: d.device,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit > 0n ? l.debit : undefined,
      credit: l.credit > 0n ? l.credit : undefined,
      memo: l.memo ?? undefined,
    })),
  });

  await ctx.tx
    .update(voucher)
    .set({ status: "approved", decidedBy: d.userId, decidedAt: sql`now()`, entryId: posted.entry.id })
    .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.id, v.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "voucher.approve",
    entityType: "voucher",
    entityId: v.id,
    after: { entryNo: posted.entry.entryNo, businessDate: posted.entry.businessDate, total: v.total },
    device: d.device,
  });
  return { entryId: posted.entry.id, entryNo: posted.entry.entryNo };
}

/** Rejects a voucher with a reason. Nothing is posted. */
export async function rejectVoucher(ctx: TenantTx, d: Decision & { note: string }): Promise<void> {
  const note = d.note.trim();
  if (!note) throw new LedgerError("INVALID_INPUT", "A reason is required to reject a voucher");
  const v = await lockPending(ctx, d.voucherId);
  if (v.createdBy === d.userId) {
    throw new LedgerError("SELF_APPROVAL", "A voucher must be rejected by someone other than its maker");
  }
  await ctx.tx
    .update(voucher)
    .set({ status: "rejected", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note.slice(0, 1000) })
    .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.id, v.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "voucher.reject",
    entityType: "voucher",
    entityId: v.id,
    after: { note },
    device: d.device,
  });
}

/** The maker withdraws their own pending voucher. */
export async function cancelVoucher(ctx: TenantTx, d: Decision & { note?: string }): Promise<void> {
  const v = await lockPending(ctx, d.voucherId);
  if (v.createdBy !== d.userId) throw new LedgerError("NOT_MAKER", "Only the person who made a voucher can cancel it");
  const note = d.note?.trim() || null;
  await ctx.tx
    .update(voucher)
    .set({ status: "cancelled", decidedBy: d.userId, decidedAt: sql`now()`, decisionNote: note })
    .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.id, v.id)));
  await recordAudit(ctx, {
    actorUserId: d.userId,
    action: "voucher.cancel",
    entityType: "voucher",
    entityId: v.id,
    after: { note },
    device: d.device,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface PersonName {
  id: string;
  nameEn: string | null;
  nameBn: string | null;
}

export interface VoucherSummary {
  id: string;
  narration: string;
  total: bigint;
  status: VoucherStatus;
  createdAt: Date;
  decidedAt: Date | null;
  maker: PersonName;
  checker: PersonName | null;
  entryNo: bigint | null;
  lineCount: number;
}

const maker = alias(appUser, "maker");
const checker = alias(appUser, "checker");

function person(p: { id: string | null; nameEn: string | null; nameBn: string | null }): PersonName | null {
  return p.id ? { id: p.id, nameEn: p.nameEn, nameBn: p.nameBn } : null;
}

export async function listVouchers(
  ctx: TenantTx,
  q: { status?: VoucherStatus; limit?: number; offset?: number } = {},
): Promise<{ vouchers: VoucherSummary[]; total: number }> {
  const where = and(eq(voucher.tenantId, ctx.tenantId), q.status ? eq(voucher.status, q.status) : undefined);
  const lineCount = sql<number>`(select count(*)::int from voucher_line l where l.tenant_id = ${voucher.tenantId} and l.voucher_id = ${voucher.id})`;
  const rows = await ctx.tx
    .select({
      v: voucher,
      lineCount,
      makerId: maker.id,
      makerEn: maker.nameEn,
      makerBn: maker.nameBn,
      checkerId: checker.id,
      checkerEn: checker.nameEn,
      checkerBn: checker.nameBn,
      entryNo: journalEntry.entryNo,
    })
    .from(voucher)
    .innerJoin(maker, and(eq(maker.tenantId, voucher.tenantId), eq(maker.id, voucher.createdBy)))
    .leftJoin(checker, and(eq(checker.tenantId, voucher.tenantId), eq(checker.id, voucher.decidedBy)))
    .leftJoin(journalEntry, and(eq(journalEntry.tenantId, voucher.tenantId), eq(journalEntry.id, voucher.entryId)))
    .where(where)
    // Pending first (oldest waiting longest on top), then the most recent decisions.
    .orderBy(
      sql`(${voucher.status} = 'pending') desc`,
      sql`case when ${voucher.status} = 'pending' then ${voucher.createdAt} end asc`,
      desc(sql`coalesce(${voucher.decidedAt}, ${voucher.createdAt})`),
    )
    .limit(q.limit ?? 50)
    .offset(q.offset ?? 0);
  const [{ n }] = (await ctx.tx.select({ n: count() }).from(voucher).where(where)) as [{ n: number }];

  return {
    total: n,
    vouchers: rows.map((r) => ({
      id: r.v.id,
      narration: r.v.narration,
      total: r.v.total,
      status: r.v.status,
      createdAt: r.v.createdAt,
      decidedAt: r.v.decidedAt,
      maker: person({ id: r.makerId, nameEn: r.makerEn, nameBn: r.makerBn })!,
      checker: person({ id: r.checkerId, nameEn: r.checkerEn, nameBn: r.checkerBn }),
      entryNo: r.entryNo,
      lineCount: r.lineCount,
    })),
  };
}

export interface VoucherStats {
  pending: { count: number; total: bigint };
  approvedThisMonth: { count: number; total: bigint };
  rejected: number;
}

/** Figures for the tiles; "this month" is the calendar month of the business date. */
export async function voucherStats(ctx: TenantTx): Promise<VoucherStats> {
  const [somiti] = await ctx.tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
  const monthStart = `${somiti!.businessDate.slice(0, 8)}01`;
  const rows = await ctx.tx
    .select({ status: voucher.status, n: count(), total: sum(voucher.total) })
    .from(voucher)
    .where(eq(voucher.tenantId, ctx.tenantId))
    .groupBy(voucher.status);
  const [approved] = await ctx.tx
    .select({ n: count(), total: sum(voucher.total) })
    .from(voucher)
    .innerJoin(journalEntry, and(eq(journalEntry.tenantId, voucher.tenantId), eq(journalEntry.id, voucher.entryId)))
    .where(and(eq(voucher.tenantId, ctx.tenantId), gte(journalEntry.businessDate, monthStart)));
  const by = new Map(rows.map((r) => [r.status, r]));
  return {
    pending: { count: by.get("pending")?.n ?? 0, total: BigInt(by.get("pending")?.total ?? 0) },
    approvedThisMonth: { count: approved?.n ?? 0, total: BigInt(approved?.total ?? 0) },
    rejected: by.get("rejected")?.n ?? 0,
  };
}

/** How many vouchers wait for someone other than `userId` to approve them. */
export async function pendingForChecker(ctx: TenantTx, userId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: count() })
    .from(voucher)
    .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.status, "pending"), sql`${voucher.createdBy} <> ${userId}`));
  return row?.n ?? 0;
}

export interface VoucherDetailLine {
  lineNo: number;
  accountId: string;
  code: string;
  nameEn: string | null;
  nameBn: string | null;
  type: (typeof ledgerAccount.$inferSelect)["type"];
  debit: bigint;
  credit: bigint;
  memo: string | null;
}

export interface VoucherDetail extends VoucherSummary {
  decisionNote: string | null;
  entryBusinessDate: string | null;
  lines: VoucherDetailLine[];
}

export async function getVoucher(ctx: TenantTx, voucherId: string): Promise<VoucherDetail | null> {
  if (!UUID.test(voucherId)) return null;
  const [r] = await ctx.tx
    .select({
      v: voucher,
      makerId: maker.id,
      makerEn: maker.nameEn,
      makerBn: maker.nameBn,
      checkerId: checker.id,
      checkerEn: checker.nameEn,
      checkerBn: checker.nameBn,
      entryNo: journalEntry.entryNo,
      entryBusinessDate: journalEntry.businessDate,
    })
    .from(voucher)
    .innerJoin(maker, and(eq(maker.tenantId, voucher.tenantId), eq(maker.id, voucher.createdBy)))
    .leftJoin(checker, and(eq(checker.tenantId, voucher.tenantId), eq(checker.id, voucher.decidedBy)))
    .leftJoin(journalEntry, and(eq(journalEntry.tenantId, voucher.tenantId), eq(journalEntry.id, voucher.entryId)))
    .where(and(eq(voucher.tenantId, ctx.tenantId), eq(voucher.id, voucherId)));
  if (!r) return null;

  const lines = await ctx.tx
    .select({
      lineNo: voucherLine.lineNo,
      accountId: voucherLine.accountId,
      code: ledgerAccount.code,
      nameEn: ledgerAccount.nameEn,
      nameBn: ledgerAccount.nameBn,
      type: ledgerAccount.type,
      debit: voucherLine.debit,
      credit: voucherLine.credit,
      memo: voucherLine.memo,
    })
    .from(voucherLine)
    .innerJoin(
      ledgerAccount,
      and(eq(ledgerAccount.tenantId, voucherLine.tenantId), eq(ledgerAccount.id, voucherLine.accountId)),
    )
    .where(and(eq(voucherLine.tenantId, ctx.tenantId), eq(voucherLine.voucherId, voucherId)))
    .orderBy(asc(voucherLine.lineNo));

  return {
    id: r.v.id,
    narration: r.v.narration,
    total: r.v.total,
    status: r.v.status,
    createdAt: r.v.createdAt,
    decidedAt: r.v.decidedAt,
    decisionNote: r.v.decisionNote,
    maker: person({ id: r.makerId, nameEn: r.makerEn, nameBn: r.makerBn })!,
    checker: person({ id: r.checkerId, nameEn: r.checkerEn, nameBn: r.checkerBn }),
    entryNo: r.entryNo,
    entryBusinessDate: r.entryBusinessDate,
    lineCount: lines.length,
    lines,
  };
}

export interface PostableAccount {
  id: string;
  code: string;
  nameEn: string | null;
  nameBn: string | null;
  type: (typeof ledgerAccount.$inferSelect)["type"];
  systemKey: string | null;
}

/** Accounts a voucher line can use, by code. */
export async function postableAccounts(ctx: TenantTx): Promise<PostableAccount[]> {
  return ctx.tx
    .select({
      id: ledgerAccount.id,
      code: ledgerAccount.code,
      nameEn: ledgerAccount.nameEn,
      nameBn: ledgerAccount.nameBn,
      type: ledgerAccount.type,
      systemKey: ledgerAccount.systemKey,
    })
    .from(ledgerAccount)
    .where(
      and(eq(ledgerAccount.tenantId, ctx.tenantId), eq(ledgerAccount.isPostable, true), eq(ledgerAccount.isActive, true)),
    )
    .orderBy(asc(ledgerAccount.code));
}

/** The branch a user's vouchers belong to: their own, else the somiti's first. */
export async function branchForUser(ctx: TenantTx, userId: string): Promise<string> {
  const [own] = await ctx.tx
    .select({ branchId: appUser.branchId })
    .from(appUser)
    .where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.id, userId)));
  if (own?.branchId) return own.branchId;
  const [first] = await ctx.tx
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.tenantId, ctx.tenantId))
    .orderBy(asc(branch.code))
    .limit(1);
  if (!first) throw new LedgerError("UNKNOWN_TENANT", "This somiti has no branch");
  return first.id;
}
