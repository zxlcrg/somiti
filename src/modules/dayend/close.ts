import { and, count, desc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { dayClose, savingsWithdrawal, tenant, voucher } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, branchForUser, cashBook, closeBusinessDay, postEntry, type CashBook } from "@/modules/ledger";
import { collectorBoard } from "@/modules/savings";
import { countCash } from "./count";

/*
 * Day-end close: the cashier counts the cash drawer note by note, the
 * count is compared with Cash in hand in the books, any difference is
 * posted to Cash over / short, and the day is locked. Mistakes found after
 * that are fixed by reversals on a later day.
 */

export function canCloseDay(roles: readonly string[]): boolean {
  return roles.includes("cashier");
}

export interface DayEndSummary {
  date: string;
  /** Cash in hand for the day: opening, in, out, and what the drawer should hold. */
  cash: Pick<CashBook, "opening" | "receipts" | "payments" | "closing">;
  entries: number;
  pendingVouchers: number;
  pendingWithdrawals: number;
  /** Collectors still holding round cash; it stays in Cash with collectors overnight. */
  collectorsHolding: { userId: string; nameEn: string | null; nameBn: string | null; held: bigint }[];
}

export async function dayEndSummary(ctx: TenantTx): Promise<DayEndSummary> {
  const { tx, tenantId } = ctx;
  const [t] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const date = t!.d;
  const { cash_in_hand } = await accountIdsByKey(ctx, ["cash_in_hand"] as const);
  const book = await cashBook(ctx, { accountId: cash_in_hand, from: date, to: date });
  const [v] = await tx.select({ n: count() }).from(voucher).where(and(eq(voucher.tenantId, tenantId), eq(voucher.status, "pending")));
  const [w] = await tx
    .select({ n: count() })
    .from(savingsWithdrawal)
    .where(and(eq(savingsWithdrawal.tenantId, tenantId), eq(savingsWithdrawal.status, "pending")));
  const board = await collectorBoard(ctx);
  return {
    date,
    cash: { opening: book.opening, receipts: book.receipts, payments: book.payments, closing: book.closing },
    entries: new Set(book.rows.map((r) => r.entryId)).size,
    pendingVouchers: v?.n ?? 0,
    pendingWithdrawals: w?.n ?? 0,
    collectorsHolding: board.filter((c) => c.held > 0n).map(({ userId, nameEn, nameBn, held }) => ({ userId, nameEn, nameBn, held })),
  };
}

export interface CloseDayInput {
  /** The business date the page showed; a stale page can't close the next day by mistake. */
  date: string;
  /** Pieces counted per denomination, as typed (Bangla digits are fine); blank is none. */
  pieces: Partial<Record<string, string>>;
  /** Loose change in typed taka. */
  other?: string;
  note?: string;
}

export type CloseDayError = "invalid_count" | "invalid_amount" | "note_required" | "note_too_long" | "wrong_date";

export type CloseDayResult =
  | { ok: true; closeId: string; expected: bigint; counted: bigint; entryNo: bigint | null; businessDate: string }
  | { ok: false; errors: Partial<Record<"pieces" | "other" | "note" | "form", CloseDayError>>; expected?: bigint };

export async function closeDay(
  ctx: TenantTx,
  input: CloseDayInput,
  actor: { userId: string; device?: string },
): Promise<CloseDayResult> {
  const errors: Partial<Record<"pieces" | "other" | "note" | "form", CloseDayError>> = {};
  const otherText = input.other?.trim() ?? "";
  const other = otherText ? parseTaka(otherText) : 0n;
  if (other === null || other < 0n) errors.other = "invalid_amount";
  const count = countCash(input.pieces, other ?? 0n);
  if (!count) errors.pieces = "invalid_count";
  const note = input.note?.trim() || null;
  if (note && note.length > 300) errors.note = "note_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  const { tx, tenantId } = ctx;
  // Lock the somiti row: nothing posts while the drawer is compared and the day closes.
  const [t] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId)).for("update");
  if (!t || t.d !== input.date) return { ok: false, errors: { form: "wrong_date" } };

  const accounts = await accountIdsByKey(ctx, ["cash_in_hand", "cash_over_short"] as const);
  const book = await cashBook(ctx, { accountId: accounts.cash_in_hand, from: input.date, to: input.date });
  const expected = book.closing;
  const { counted, breakdown } = count!;
  const difference = counted - expected;
  if (difference !== 0n && !note) return { ok: false, errors: { note: "note_required" }, expected };

  let entry: { id: string; entryNo: bigint } | null = null;
  if (difference !== 0n) {
    const amount = difference > 0n ? difference : -difference;
    const posted = await postEntry(ctx, {
      branchId: await branchForUser(ctx, actor.userId),
      source: "day_close",
      narration: `Cash ${difference > 0n ? "over" : "short"} at day-end count: ${note}`,
      createdBy: actor.userId,
      idempotencyKey: `day-close:${input.date}`,
      device: actor.device,
      lines:
        difference > 0n
          ? [
              { accountId: accounts.cash_in_hand, debit: amount },
              { accountId: accounts.cash_over_short, credit: amount },
            ]
          : [
              { accountId: accounts.cash_over_short, debit: amount },
              { accountId: accounts.cash_in_hand, credit: amount },
            ],
    });
    entry = { id: posted.entry.id, entryNo: posted.entry.entryNo };
  }

  const [row] = await tx
    .insert(dayClose)
    .values({ tenantId, businessDate: input.date, expected, counted, breakdown, entryId: entry?.id ?? null, note, closedBy: actor.userId })
    .returning({ id: dayClose.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "dayend.close",
    entityType: "day_close",
    entityId: row!.id,
    after: { date: input.date, expected: expected.toString(), counted: counted.toString(), breakdown, note, entryNo: entry?.entryNo ?? null },
    device: actor.device,
  });
  const closed = await closeBusinessDay(ctx, { date: input.date, closedBy: actor.userId, device: actor.device });
  return { ok: true, closeId: row!.id, expected, counted, entryNo: entry?.entryNo ?? null, businessDate: closed.businessDate };
}

export interface DayCloseView {
  id: string;
  businessDate: string;
  expected: bigint;
  counted: bigint;
  breakdown: Record<string, number>;
  note: string | null;
  entryNo: bigint | null;
  closedBy: { nameEn: string | null; nameBn: string | null };
  createdAt: Date;
}

export async function listDayCloses(ctx: TenantTx, limit = 14): Promise<DayCloseView[]> {
  const rows = await ctx.tx
    .select({
      id: dayClose.id,
      businessDate: dayClose.businessDate,
      expected: dayClose.expected,
      counted: dayClose.counted,
      breakdown: dayClose.breakdown,
      note: dayClose.note,
      createdAt: dayClose.createdAt,
      entryNo: sql<string | null>`(select je.entry_no from journal_entry je where je.tenant_id = "day_close"."tenant_id" and je.id = "day_close"."entry_id")`,
      byEn: sql<string | null>`(select u.name_en from app_user u where u.tenant_id = "day_close"."tenant_id" and u.id = "day_close"."closed_by")`,
      byBn: sql<string | null>`(select u.name_bn from app_user u where u.tenant_id = "day_close"."tenant_id" and u.id = "day_close"."closed_by")`,
    })
    .from(dayClose)
    .where(eq(dayClose.tenantId, ctx.tenantId))
    .orderBy(desc(dayClose.businessDate))
    .limit(limit);
  return rows.map(({ byEn, byBn, entryNo, ...r }) => ({
    ...r,
    entryNo: entryNo === null ? null : BigInt(entryNo),
    closedBy: { nameEn: byEn, nameBn: byBn },
  }));
}

