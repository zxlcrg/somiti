import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { ledgerAccount, member, tenant } from "@/db/schema";
import { accountIdsByKey, controlBalances } from "@/modules/ledger";

/*
 * The books check: every account that holds member money is held up against
 * the member records it should equal. Savings passbooks against Member
 * savings (2100), share holdings against Share capital (3100), principal
 * still owed on loans against Loans receivable (1300), and cash collectors
 * have not handed over against Cash with collectors (1110). Both sides are
 * read fresh, so a difference means a posting went somewhere it shouldn't.
 */

export const CHECKS = ["savings", "shares", "loans", "collectorCash"] as const;
export type CheckKey = (typeof CHECKS)[number];

const LEDGER_KEY = {
  savings: "member_savings",
  shares: "share_capital",
  loans: "loans_receivable",
  collectorCash: "cash_with_collector",
} as const satisfies Record<CheckKey, string>;

/** Liabilities and equity sit on the credit side; turn them positive. */
const CREDIT_SIDE: Record<CheckKey, boolean> = { savings: true, shares: true, loans: false, collectorCash: false };

export interface MemberDifference {
  memberId: string;
  memberNo: number;
  nameEn: string | null;
  nameBn: string | null;
  books: bigint;
  records: bigint;
}

export interface CheckResult {
  key: CheckKey;
  /** Ledger account code, e.g. "2100". */
  code: string;
  nameEn: string | null;
  nameBn: string | null;
  books: bigint;
  records: bigint;
  /** Lines on the account that name no member (collector cash never does). */
  untagged: bigint;
  /** Members whose own records and ledger lines disagree, biggest gap first. */
  members: MemberDifference[];
}

export interface BooksCheck {
  asOf: string;
  checks: CheckResult[];
  /** True when every pair agrees, member by member. */
  ok: boolean;
}

const notReversed = (alias: string) =>
  sql.raw(`not exists (select 1 from journal_entry rev where rev.tenant_id = ${alias}.tenant_id and rev.reverses_id = ${alias}.journal_entry_id)`);

type PerMember = Map<string, bigint>;

async function perMember(ctx: TenantTx, query: ReturnType<typeof sql>): Promise<PerMember> {
  const res = await ctx.tx.execute<{ member_id: string; amount: string }>(query);
  return new Map(res.rows.map((r) => [r.member_id, BigInt(r.amount)]));
}

/** What the member records say, per member, in the account's own direction. */
async function recordBalances(ctx: TenantTx): Promise<Record<Exclude<CheckKey, "collectorCash">, PerMember> & { collectorCash: bigint }> {
  const { tenantId } = ctx;
  const savings = await perMember(
    ctx,
    sql`select a.member_id, sum(case when t.kind = 'withdrawal' then -t.amount else t.amount end)::text as amount
          from savings_transaction t
          join savings_account a on a.tenant_id = t.tenant_id and a.id = t.account_id
         where t.tenant_id = ${tenantId} and ${notReversed("t")}
         group by a.member_id`,
  );
  const shares = await perMember(
    ctx,
    sql`select s.member_id, sum(case when s.kind = 'refund' then -s.amount else s.amount end)::text as amount
          from share_transaction s
         where s.tenant_id = ${tenantId} and ${notReversed("s")}
         group by s.member_id`,
  );
  // An imported loan's principal is what was still owed on the day it came in.
  const loans = await perMember(
    ctx,
    sql`select l.member_id, sum(
               l.principal
             - (select coalesce(sum(p.principal), 0) from loan_repayment p
                 where p.tenant_id = l.tenant_id and p.loan_id = l.id and ${notReversed("p")})
             - (select coalesce(sum(w.principal), 0) from loan_write_off w
                 where w.tenant_id = l.tenant_id and w.loan_id = l.id and w.status = 'approved'))::text as amount
          from loan l
         where l.tenant_id = ${tenantId} and l.status in ('disbursed', 'closed', 'written_off')
         group by l.member_id`,
  );
  const held = await ctx.tx.execute<{ held: string }>(sql`
    select
      (select coalesce(sum(t.amount + coalesce((select f.amount from savings_fine f where f.tenant_id = t.tenant_id and f.journal_entry_id = t.journal_entry_id), 0)), 0)
         from savings_transaction t
        where t.tenant_id = ${tenantId} and t.channel = 'collector' and t.kind = 'deposit' and ${notReversed("t")})
      + (select coalesce(sum(p.amount + p.fine), 0) from loan_repayment p
          where p.tenant_id = ${tenantId} and p.channel = 'collector' and ${notReversed("p")})
      - (select coalesce(sum(h.amount), 0) from collector_handover h
          where h.tenant_id = ${tenantId} and ${notReversed("h")})
      as held`);
  return { savings, shares, loans, collectorCash: BigInt(held.rows[0]?.held ?? 0) };
}

const sum = (m: PerMember) => [...m.values()].reduce((s, v) => s + v, 0n);

/** Runs the books check as of the somiti's business date. */
export async function booksCheck(ctx: TenantTx): Promise<BooksCheck> {
  const [somiti] = await ctx.tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
  const asOf = somiti!.businessDate;
  const ids = await accountIdsByKey(ctx, Object.values(LEDGER_KEY));
  const accounts = Object.fromEntries(CHECKS.map((k) => [k, ids[LEDGER_KEY[k]]])) as Record<CheckKey, string>;
  const ledger = await controlBalances(ctx, accounts, asOf);
  const records = await recordBalances(ctx);
  const names = await ctx.tx
    .select({ id: ledgerAccount.id, code: ledgerAccount.code, nameEn: ledgerAccount.nameEn, nameBn: ledgerAccount.nameBn })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, ctx.tenantId), inArray(ledgerAccount.id, Object.values(accounts))));

  const raw: Array<Omit<CheckResult, "members"> & { gaps: Array<{ memberId: string; books: bigint; records: bigint }> }> = CHECKS.map((key) => {
    const l = ledger[key];
    const sign = CREDIT_SIDE[key] ? -1n : 1n;
    const acct = names.find((r) => r.id === accounts[key])!;
    const base = { key, code: acct.code, nameEn: acct.nameEn, nameBn: acct.nameBn, books: sign * l.total };
    // Collector cash is never tagged with a member, so it is checked in total only.
    if (key === "collectorCash") return { ...base, untagged: 0n, records: records.collectorCash, gaps: [] };
    const mine = records[key];
    const gaps: Array<{ memberId: string; books: bigint; records: bigint }> = [];
    for (const id of new Set([...mine.keys(), ...l.byMember.keys()])) {
      const books = sign * (l.byMember.get(id) ?? 0n);
      const rec = mine.get(id) ?? 0n;
      if (books !== rec) gaps.push({ memberId: id, books, records: rec });
    }
    return { ...base, untagged: sign * l.untagged, records: sum(mine), gaps };
  });

  const memberIds = [...new Set(raw.flatMap((r) => r.gaps.map((g) => g.memberId)))];
  const people = memberIds.length
    ? await ctx.tx
        .select({ id: member.id, memberNo: member.memberNo, nameEn: member.nameEn, nameBn: member.nameBn })
        .from(member)
        .where(inArray(member.id, memberIds))
    : [];
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const checks = raw.map(({ gaps, ...r }) => ({
    ...r,
    members: gaps
      .map((g) => {
        const p = people.find((x) => x.id === g.memberId)!;
        return { ...g, memberNo: p.memberNo, nameEn: p.nameEn, nameBn: p.nameBn };
      })
      .sort((a, b) => (abs(b.books - b.records) > abs(a.books - a.records) ? 1 : -1)),
  }));
  return { asOf, checks, ok: checks.every((c) => c.books === c.records && c.untagged === 0n && c.members.length === 0) };
}
