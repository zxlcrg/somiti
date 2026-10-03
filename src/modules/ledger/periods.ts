import { and, eq } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { fiscalPeriod, tenant } from "@/db/schema";
import { addDays } from "@/lib/dates";
import { recordAudit } from "@/modules/audit/log";
import { LedgerError } from "./errors";

/**
 * Locks the current business day and moves the business date to the next
 * day. Nothing can post on or before a locked day afterwards; mistakes are
 * fixed by reversals on a later date.
 *
 * This is the ledger half of day-end close. The cashier's cash count and
 * over/short posting arrive with the savings flow in M2.
 */
export async function closeBusinessDay(
  ctx: TenantTx,
  input: { date: string; closedBy: string; device?: string },
): Promise<{ lockedThrough: string; businessDate: string }> {
  const [t] = await ctx.tx.select().from(tenant).where(eq(tenant.id, ctx.tenantId)).for("update");
  if (!t) throw new LedgerError("UNKNOWN_TENANT", "Tenant not found");
  if (t.businessDate !== input.date) {
    throw new LedgerError(
      "WRONG_BUSINESS_DATE",
      `The business date is ${t.businessDate}, not ${input.date}`,
    );
  }
  const next = addDays(input.date, 1);
  await ctx.tx
    .update(tenant)
    .set({ lockedThrough: input.date, businessDate: next })
    .where(eq(tenant.id, ctx.tenantId));
  await recordAudit(ctx, {
    actorUserId: input.closedBy,
    action: "ledger.close_day",
    entityType: "tenant",
    entityId: ctx.tenantId,
    before: { businessDate: t.businessDate, lockedThrough: t.lockedThrough },
    after: { businessDate: next, lockedThrough: input.date },
    device: input.device,
  });
  return { lockedThrough: input.date, businessDate: next };
}

export async function openFiscalPeriod(
  ctx: TenantTx,
  input: { startDate: string; endDate: string; openedBy: string },
): Promise<string> {
  const [row] = await ctx.tx
    .insert(fiscalPeriod)
    .values({ tenantId: ctx.tenantId, startDate: input.startDate, endDate: input.endDate })
    .returning({ id: fiscalPeriod.id });
  await recordAudit(ctx, {
    actorUserId: input.openedBy,
    action: "ledger.open_period",
    entityType: "fiscal_period",
    entityId: row!.id,
    after: input,
  });
  return row!.id;
}

/**
 * Closes a fiscal period so nothing more can post into it. Closing entries,
 * reserve and dividends (the rest of year-end) are M5.
 */
export async function closeFiscalPeriod(
  ctx: TenantTx,
  input: { periodId: string; closedBy: string },
): Promise<void> {
  const updated = await ctx.tx
    .update(fiscalPeriod)
    .set({ status: "closed", closedAt: new Date(), closedBy: input.closedBy })
    .where(and(eq(fiscalPeriod.tenantId, ctx.tenantId), eq(fiscalPeriod.id, input.periodId)))
    .returning({ id: fiscalPeriod.id });
  if (updated.length === 0) throw new LedgerError("NOT_FOUND", "Fiscal period not found");
  await recordAudit(ctx, {
    actorUserId: input.closedBy,
    action: "ledger.close_period",
    entityType: "fiscal_period",
    entityId: input.periodId,
    after: { status: "closed" },
  });
}
