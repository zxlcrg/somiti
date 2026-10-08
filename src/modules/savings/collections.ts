import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { appUser, collectorHandover, idempotencyKey, tenant, userRole } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, branchForUser, postEntry } from "@/modules/ledger";

/*
 * A field collector's deposits go to Cash with collector (see deposit()).
 * The cash is theirs to bring in: at the office a cashier counts it and
 * records the handover, which moves it to Cash in hand. What a collector
 * still holds is their round's deposits less what they have handed over,
 * counting only entries that were not reversed. Late fines taken with a
 * deposit, and loan repayments taken on the round, are cash in the
 * collector's bag too.
 */

export function canReceiveHandovers(roles: readonly string[]): boolean {
  return roles.includes("cashier");
}

const notReversed = (alias: string) =>
  sql.raw(
    `not exists (select 1 from journal_entry r where r.tenant_id = ${alias}.tenant_id and r.reverses_id = ${alias}.journal_entry_id)`,
  );

/** A deposit row's cash: the deposit plus any late fine taken with it. */
const withFine = sql.raw(
  `t.amount + coalesce((select f.amount from savings_fine f where f.tenant_id = t.tenant_id and f.journal_entry_id = t.journal_entry_id), 0)`,
);

/** Loan repayments a collector took, optionally on one business day. */
const loanCash = (user: ReturnType<typeof sql>, day?: string) => sql`
  (select coalesce(sum(p.amount), 0) from loan_repayment p
    where p.tenant_id = ${sql.raw("u.tenant_id")} and p.created_by = ${user} and p.channel = 'collector'
      ${day ? sql`and p.business_date = ${day}` : sql``} and ${notReversed("p")})`;

/** Cash a collector holds right now, in paisa. */
async function heldBy(ctx: TenantTx, collectorId: string): Promise<bigint> {
  const res = await ctx.tx.execute<{ held: string }>(sql`
    select
      (select coalesce(sum(${withFine}), 0) from savings_transaction t
        where t.tenant_id = ${ctx.tenantId} and t.created_by = ${collectorId}
          and t.channel = 'collector' and t.kind = 'deposit' and ${notReversed("t")})
      +
      (select coalesce(sum(p.amount), 0) from loan_repayment p
        where p.tenant_id = ${ctx.tenantId} and p.created_by = ${collectorId}
          and p.channel = 'collector' and ${notReversed("p")})
      -
      (select coalesce(sum(h.amount), 0) from collector_handover h
        where h.tenant_id = ${ctx.tenantId} and h.collector_id = ${collectorId} and ${notReversed("h")})
      as held`);
  return BigInt(res.rows[0]?.held ?? 0);
}

export interface CollectorStatus {
  userId: string;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  held: bigint;
  /** Deposits taken on today's business date, with any late fines. */
  todayCount: number;
  todayAmount: bigint;
  lastHandover: { amount: bigint; at: Date } | null;
}

/** Every field collector with what they hold, worst first. */
export async function collectorBoard(ctx: TenantTx): Promise<CollectorStatus[]> {
  const { tx, tenantId } = ctx;
  const [day] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const rows = await tx.execute<{
    id: string;
    name_en: string | null;
    name_bn: string | null;
    phone: string;
    collected: string;
    handed: string;
    today_count: number;
    today_amount: string;
    last_amount: string | null;
    last_at: Date | null;
  }>(sql`
    select u.id, u.name_en, u.name_bn, u.phone,
      (select coalesce(sum(${withFine}), 0) from savings_transaction t
        where t.tenant_id = u.tenant_id and t.created_by = u.id
          and t.channel = 'collector' and t.kind = 'deposit' and ${notReversed("t")})
        + ${loanCash(sql.raw("u.id"))} as collected,
      (select coalesce(sum(h.amount), 0) from collector_handover h
        where h.tenant_id = u.tenant_id and h.collector_id = u.id and ${notReversed("h")}) as handed,
      (select count(*)::int from savings_transaction t
        where t.tenant_id = u.tenant_id and t.created_by = u.id and t.channel = 'collector'
          and t.kind = 'deposit' and t.business_date = ${day!.d} and ${notReversed("t")})
        + (select count(*)::int from loan_repayment p
            where p.tenant_id = u.tenant_id and p.created_by = u.id and p.channel = 'collector'
              and p.business_date = ${day!.d} and ${notReversed("p")}) as today_count,
      (select coalesce(sum(${withFine}), 0) from savings_transaction t
        where t.tenant_id = u.tenant_id and t.created_by = u.id and t.channel = 'collector'
          and t.kind = 'deposit' and t.business_date = ${day!.d} and ${notReversed("t")})
        + ${loanCash(sql.raw("u.id"), day!.d)} as today_amount,
      last.amount as last_amount, last.created_at as last_at
    from app_user u
    join user_role ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.role = 'field_collector'
    left join lateral (
      select h.amount, h.created_at from collector_handover h
       where h.tenant_id = u.tenant_id and h.collector_id = u.id and ${notReversed("h")}
       order by h.created_at desc limit 1
    ) last on true
    where u.tenant_id = ${tenantId}`);
  return rows.rows
    .map((r) => ({
      userId: r.id,
      nameEn: r.name_en,
      nameBn: r.name_bn,
      phone: r.phone,
      held: BigInt(r.collected) - BigInt(r.handed),
      todayCount: Number(r.today_count),
      todayAmount: BigInt(r.today_amount),
      lastHandover: r.last_amount === null ? null : { amount: BigInt(r.last_amount), at: new Date(r.last_at!) },
    }))
    .sort((a, b) => (b.held > a.held ? 1 : b.held < a.held ? -1 : (a.nameEn ?? "").localeCompare(b.nameEn ?? "")));
}

export interface HandoverInput {
  collectorId: string;
  /** Typed taka, as counted; Bangla digits are fine. */
  amount: string;
  note?: string;
  /** Generated once per form, so a double submit posts once. */
  idempotencyKey: string;
}

export type HandoverError = "invalid_amount" | "over_held" | "not_collector" | "self" | "note_too_long";

export type HandoverResult =
  | { ok: true; handoverId: string; entryNo: bigint; replayed: boolean }
  | { ok: false; errors: Partial<Record<"amount" | "note" | "form", HandoverError>>; held?: bigint };

/**
 * Records cash counted in from a collector: Dr Cash in hand, Cr Cash with
 * collector. Handovers for one collector take turns, so two cashiers can't
 * both receive the same cash.
 */
export async function receiveHandover(
  ctx: TenantTx,
  input: HandoverInput,
  actor: { userId: string; device?: string },
): Promise<HandoverResult> {
  const errors: Partial<Record<"amount" | "note" | "form", HandoverError>> = {};
  const amount = parseTaka(input.amount);
  if (amount === null || amount <= 0n) errors.amount = "invalid_amount";
  const note = input.note?.trim() || null;
  if (note && note.length > 300) errors.note = "note_too_long";
  if (input.collectorId === actor.userId) errors.form = "self";
  if (Object.keys(errors).length) return { ok: false, errors };

  const { tx, tenantId } = ctx;
  const [collector] = await tx
    .select({ id: appUser.id, nameEn: appUser.nameEn })
    .from(appUser)
    .innerJoin(
      userRole,
      and(eq(userRole.tenantId, appUser.tenantId), eq(userRole.userId, appUser.id), eq(userRole.role, "field_collector")),
    )
    .where(and(eq(appUser.tenantId, tenantId), eq(appUser.id, input.collectorId)));
  if (!collector) return { ok: false, errors: { form: "not_collector" } };

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`collector_handover:${tenantId}:${collector.id}`}))`);
  // A repeat of a form that already went through returns the first handover.
  const [prior] = await tx
    .select({
      id: collectorHandover.id,
      collectorId: collectorHandover.collectorId,
      entryNo: sql<string>`(select je.entry_no from journal_entry je where je.tenant_id = "collector_handover"."tenant_id" and je.id = "collector_handover"."journal_entry_id")`,
    })
    .from(collectorHandover)
    .innerJoin(idempotencyKey, and(eq(idempotencyKey.tenantId, collectorHandover.tenantId), eq(idempotencyKey.resultId, collectorHandover.journalEntryId)))
    .where(and(eq(collectorHandover.tenantId, tenantId), eq(idempotencyKey.key, input.idempotencyKey)));
  if (prior && prior.collectorId === collector.id) return { ok: true, handoverId: prior.id, entryNo: BigInt(prior.entryNo), replayed: true };

  const held = await heldBy(ctx, collector.id);
  if (amount! > held) return { ok: false, errors: { amount: "over_held" }, held: held > 0n ? held : 0n };

  const accounts = await accountIdsByKey(ctx, ["cash_in_hand", "cash_with_collector"] as const);
  const posted = await postEntry(ctx, {
    branchId: await branchForUser(ctx, collector.id),
    source: "collector_handover",
    narration: `Cash handed over by collector ${collector.nameEn ?? collector.id}${note ? `: ${note}` : ""}`,
    createdBy: actor.userId,
    idempotencyKey: input.idempotencyKey,
    device: actor.device,
    lines: [
      { accountId: accounts.cash_in_hand, debit: amount! },
      { accountId: accounts.cash_with_collector, credit: amount! },
    ],
  });
  const [row] = await tx
    .insert(collectorHandover)
    .values({
      tenantId,
      collectorId: collector.id,
      amount: amount!,
      receivedBy: actor.userId,
      journalEntryId: posted.entry.id,
      businessDate: posted.entry.businessDate,
      note,
    })
    .returning({ id: collectorHandover.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "savings.handover",
    entityType: "collector_handover",
    entityId: row!.id,
    after: { collectorId: collector.id, amount: amount!.toString(), entryNo: posted.entry.entryNo, note },
    device: actor.device,
  });
  return { ok: true, handoverId: row!.id, entryNo: posted.entry.entryNo, replayed: false };
}

export interface HandoverView {
  id: string;
  collectorId: string;
  collectorEn: string | null;
  collectorBn: string | null;
  receivedEn: string | null;
  receivedBn: string | null;
  amount: bigint;
  note: string | null;
  businessDate: string;
  createdAt: Date;
  entryNo: bigint;
  reversed: boolean;
}

export async function listHandovers(ctx: TenantTx, filter: { collectorId?: string; limit?: number } = {}): Promise<HandoverView[]> {
  const name = (col: "collector_id" | "received_by", lang: "en" | "bn") =>
    sql<string | null>`(select u.name_${sql.raw(lang)} from app_user u where u.tenant_id = "collector_handover"."tenant_id" and u.id = "collector_handover".${sql.raw(`"${col}"`)})`;
  const rows = await ctx.tx
    .select({
      id: collectorHandover.id,
      collectorId: collectorHandover.collectorId,
      collectorEn: name("collector_id", "en"),
      collectorBn: name("collector_id", "bn"),
      receivedEn: name("received_by", "en"),
      receivedBn: name("received_by", "bn"),
      amount: collectorHandover.amount,
      note: collectorHandover.note,
      businessDate: collectorHandover.businessDate,
      createdAt: collectorHandover.createdAt,
      entryNo: sql<string>`(select je.entry_no from journal_entry je where je.tenant_id = "collector_handover"."tenant_id" and je.id = "collector_handover"."journal_entry_id")`,
      reversed: sql<boolean>`exists (select 1 from journal_entry r where r.tenant_id = "collector_handover"."tenant_id" and r.reverses_id = "collector_handover"."journal_entry_id")`,
    })
    .from(collectorHandover)
    .where(
      and(
        eq(collectorHandover.tenantId, ctx.tenantId),
        filter.collectorId ? eq(collectorHandover.collectorId, filter.collectorId) : undefined,
      ),
    )
    .orderBy(desc(collectorHandover.createdAt))
    .limit(filter.limit ?? 30);
  return rows.map((r) => ({ ...r, entryNo: BigInt(r.entryNo) }));
}
