import { eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { tenant } from "@/db/schema";
import { addDays } from "@/lib/dates";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, trialBalance } from "@/modules/ledger";
import { photoVersion } from "@/modules/members/photos";
import { savingsOverview } from "@/modules/savings";

/*
 * Figures for the home page, read fresh on every visit like the rest of the
 * app: nothing here is stored or cached. "This month" is the calendar month
 * of the business date, not of the wall clock, so a day not yet closed still
 * counts in the month it belongs to.
 */

/** Rows reversed by a later journal entry don't count anywhere on the dashboard. */
const notReversed = (alias: string) =>
  sql.raw(`not exists (select 1 from journal_entry rev where rev.tenant_id = ${alias}.tenant_id and rev.reverses_id = ${alias}.journal_entry_id)`);

/** What has been settled on each loan installment: repayments (rebates included) and amounts moved by a reschedule. */
const paidCte = (tenantId: string) => sql`
  paid as (
    select loan_id, seq, sum(amount) as paid
      from (select x.loan_id, x.seq, x.principal + x.interest + x.rebate as amount
              from loan_repayment_line x where x.tenant_id = ${tenantId}
            union all
            select m.loan_id, m.seq, m.principal + m.interest
              from loan_reschedule_line m where m.tenant_id = ${tenantId}) settled
     group by loan_id, seq
  )`;

export interface MonthFigures {
  /** "2026-10" */
  month: string;
  /** Savings deposits taken in the month. */
  savings: bigint;
  /** Loan repayments taken in the month, late fines included. */
  repayments: bigint;
  /** Loan principal paid out in the month. */
  disbursed: bigint;
}

export interface PortfolioBucket {
  count: number;
  /** Principal still owed on those loans. */
  amount: bigint;
}

export interface DashboardOverview {
  today: string;
  members: { total: number; active: number; newThisMonth: number };
  savings: { balance: bigint; accounts: number; thisMonth: bigint };
  loans: { outstanding: bigint; live: number; waiting: number };
  overdue: { amount: bigint; loans: number };
  cash: { total: bigint; inHand: bigint; withCollectors: bigint; bank: bigint; wallet: bigint };
  shareCapital: bigint;
  /** The last six months, oldest first; the last one is the business date's month. */
  months: MonthFigures[];
  target: bigint | null;
  portfolio: { onTrack: PortfolioBucket; dueSoon: PortfolioBucket; overdue: PortfolioBucket };
  /** Savings deposits and loan repayments taken on the business date so far. */
  taken: { count: number; amount: bigint };
}

export async function dashboardOverview(ctx: TenantTx): Promise<DashboardOverview> {
  const { tx, tenantId } = ctx;
  const [somiti] = await tx
    .select({ today: tenant.businessDate, target: tenant.collectionTarget })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const today = somiti!.today;
  const soon = addDays(today, 7);

  const counts = await tx.execute<{
    members: number;
    active: number;
    new_members: number;
    live: number;
    waiting: number;
    outstanding: string;
    today_count: number;
    today_amount: string;
  }>(sql`
    select
      (select count(*)::int from member m where m.tenant_id = ${tenantId}) as members,
      (select count(*)::int from member m where m.tenant_id = ${tenantId} and m.status = 'active') as active,
      (select count(*)::int from member m where m.tenant_id = ${tenantId}
          and date_trunc('month', m.admission_date) = date_trunc('month', ${today}::date)) as new_members,
      (select count(*)::int from loan l where l.tenant_id = ${tenantId} and l.status = 'disbursed') as live,
      (select count(*)::int from loan l where l.tenant_id = ${tenantId} and l.status in ('applied', 'approved')) as waiting,
      (select coalesce(sum(l.principal - (select coalesce(sum(p.principal), 0) from loan_repayment p
                                            where p.tenant_id = l.tenant_id and p.loan_id = l.id)), 0)::text
         from loan l where l.tenant_id = ${tenantId} and l.status = 'disbursed') as outstanding,
      (select count(*)::int from savings_transaction t where t.tenant_id = ${tenantId} and t.kind = 'deposit'
          and t.business_date = ${today}::date and ${notReversed("t")})
        + (select count(*)::int from loan_repayment p where p.tenant_id = ${tenantId}
          and p.business_date = ${today}::date and ${notReversed("p")}) as today_count,
      ((select coalesce(sum(t.amount), 0) from savings_transaction t where t.tenant_id = ${tenantId} and t.kind = 'deposit'
          and t.business_date = ${today}::date and ${notReversed("t")})
        + (select coalesce(sum(p.amount + p.fine), 0) from loan_repayment p where p.tenant_id = ${tenantId}
          and p.business_date = ${today}::date and ${notReversed("p")}))::text as today_amount`);
  const c = counts.rows[0]!;

  const months = await tx.execute<{ month: string; savings: string; repayments: string; disbursed: string }>(sql`
    select to_char(m, 'YYYY-MM') as month,
      (select coalesce(sum(t.amount), 0) from savings_transaction t
        where t.tenant_id = ${tenantId} and t.kind = 'deposit' and t.business_date >= m and t.business_date < m + interval '1 month'
          and ${notReversed("t")})::text as savings,
      (select coalesce(sum(p.amount + p.fine), 0) from loan_repayment p
        where p.tenant_id = ${tenantId} and p.business_date >= m and p.business_date < m + interval '1 month'
          and ${notReversed("p")})::text as repayments,
      (select coalesce(sum(l.principal), 0) from loan l
        where l.tenant_id = ${tenantId} and l.disbursed_on >= m and l.disbursed_on < m + interval '1 month')::text as disbursed
    from generate_series(date_trunc('month', ${today}::date) - interval '5 months', date_trunc('month', ${today}::date), interval '1 month') m
    order by m`);

  // Each running loan once: what principal is left, and whether anything is late or falls due within a week.
  const book = await tx.execute<{ bucket: "overdue" | "dueSoon" | "onTrack"; count: number; amount: string; owing: string }>(sql`
    with ${paidCte(tenantId)},
    open_inst as (
      select i.loan_id, i.due_on, i.principal + i.interest - coalesce(p.paid, 0) as owing
        from loan_installment i
        join loan l on l.tenant_id = i.tenant_id and l.id = i.loan_id and l.status = 'disbursed'
        left join paid p on p.loan_id = i.loan_id and p.seq = i.seq
       where i.tenant_id = ${tenantId}
    ), per_loan as (
      select l.id,
             l.principal - (select coalesce(sum(r.principal), 0) from loan_repayment r where r.tenant_id = l.tenant_id and r.loan_id = l.id) as left_principal,
             (select coalesce(sum(o.owing), 0) from open_inst o where o.loan_id = l.id and o.owing > 0 and o.due_on < ${today}::date) as late,
             exists (select 1 from open_inst o where o.loan_id = l.id and o.owing > 0 and o.due_on between ${today}::date and ${soon}::date) as soon
        from loan l
       where l.tenant_id = ${tenantId} and l.status = 'disbursed'
    )
    select case when late > 0 then 'overdue' when soon then 'dueSoon' else 'onTrack' end as bucket,
           count(*)::int as count, coalesce(sum(left_principal), 0)::text as amount, coalesce(sum(late), 0)::text as owing
      from per_loan group by 1`);
  const bucket = (b: "overdue" | "dueSoon" | "onTrack") => {
    const r = book.rows.find((x) => x.bucket === b);
    return { count: r?.count ?? 0, amount: BigInt(r?.amount ?? 0) };
  };
  const overdueRow = book.rows.find((x) => x.bucket === "overdue");

  const saved = await savingsOverview(ctx);
  const tb = await trialBalance(ctx, today);
  const keys = await accountIdsByKey(ctx, ["cash_in_hand", "cash_with_collector", "bank", "mobile_wallet", "share_capital"] as const);
  const net = (id: string) => {
    const r = tb.rows.find((x) => x.accountId === id);
    return r ? r.debit - r.credit : 0n;
  };
  const cash = {
    inHand: net(keys.cash_in_hand),
    withCollectors: net(keys.cash_with_collector),
    bank: net(keys.bank),
    wallet: net(keys.mobile_wallet),
  };

  return {
    today,
    members: { total: c.members, active: c.active, newThisMonth: c.new_members },
    savings: { balance: saved.totalBalance, accounts: saved.openAccounts, thisMonth: BigInt(months.rows.at(-1)?.savings ?? 0) },
    loans: { outstanding: BigInt(c.outstanding), live: c.live, waiting: c.waiting },
    overdue: { amount: BigInt(overdueRow?.owing ?? 0), loans: overdueRow?.count ?? 0 },
    cash: { ...cash, total: cash.inHand + cash.withCollectors + cash.bank + cash.wallet },
    shareCapital: -net(keys.share_capital),
    months: months.rows.map((r) => ({ month: r.month, savings: BigInt(r.savings), repayments: BigInt(r.repayments), disbursed: BigInt(r.disbursed) })),
    target: somiti!.target,
    portfolio: { onTrack: bucket("onTrack"), dueSoon: bucket("dueSoon"), overdue: bucket("overdue") },
    taken: { count: c.today_count, amount: BigInt(c.today_amount) },
  };
}

// ---------- To collect ----------

export interface CollectRow {
  kind: "loan" | "savings";
  /** Loan or savings account id. */
  id: string;
  member: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null; phone: string; photoVersion: string | null };
  /** Loan number or savings account number. */
  no: number;
  productCode: string;
  /** Owing on installments due on or before the business date. */
  amount: bigint;
  /** The oldest unpaid due date (loans), or null for savings. */
  since: string | null;
  late: boolean;
  /** A payment was already taken on the business date. */
  paidToday: boolean;
}

/**
 * Who should pay today: running loans with installments due on or before the
 * business date and not fully paid, oldest first, then scheduled savings
 * accounts behind on their installments, most behind first.
 */
export async function toCollect(ctx: TenantTx, limit = 8): Promise<{ rows: CollectRow[]; total: number; amount: bigint }> {
  const { tx, tenantId } = ctx;
  const [somiti] = await tx.select({ today: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const today = somiti!.today;
  const loans = await tx.execute<{
    id: string;
    loan_no: number;
    code: string;
    member_id: string;
    member_no: number;
    name_en: string | null;
    name_bn: string | null;
    phone: string;
    photo_sha: string | null;
    amount: string;
    since: string;
    paid_today: boolean;
  }>(sql`
    with ${paidCte(tenantId)},
    due as (
      select i.loan_id, sum(i.principal + i.interest - coalesce(p.paid, 0)) as amount, min(i.due_on) as since
        from loan_installment i
        left join paid p on p.loan_id = i.loan_id and p.seq = i.seq
       where i.tenant_id = ${tenantId} and i.due_on <= ${today}::date
         and i.principal + i.interest > coalesce(p.paid, 0)
       group by i.loan_id
    )
    select l.id, l.loan_no, lp.code, m.id as member_id, m.member_no, m.name_en, m.name_bn, m.phone,
           (select ph.sha256 from member_photo ph where ph.tenant_id = m.tenant_id and ph.member_id = m.id and ph.removed_at is null
             order by ph.created_at desc limit 1) as photo_sha,
           d.amount::text as amount, to_char(d.since, 'YYYY-MM-DD') as since,
           exists (select 1 from loan_repayment r where r.tenant_id = l.tenant_id and r.loan_id = l.id
                    and r.business_date = ${today}::date and ${notReversed("r")}) as paid_today
      from due d
      join loan l on l.tenant_id = ${tenantId} and l.id = d.loan_id and l.status = 'disbursed'
      join loan_product lp on lp.tenant_id = l.tenant_id and lp.id = l.product_id
      join member m on m.tenant_id = l.tenant_id and m.id = l.member_id
     order by d.since, l.loan_no`);
  const rows: CollectRow[] = loans.rows.map((r) => ({
    kind: "loan",
    id: r.id,
    member: { id: r.member_id, memberNo: r.member_no, nameEn: r.name_en, nameBn: r.name_bn, phone: r.phone, photoVersion: r.photo_sha ? photoVersion(r.photo_sha) : null },
    no: r.loan_no,
    productCode: r.code,
    amount: BigInt(r.amount),
    since: r.since,
    late: r.since < today,
    paidToday: r.paid_today,
  }));
  // Savings accounts behind on their installments, worst first (savingsOverview keeps the eight worst).
  const saved = await savingsOverview(ctx);
  for (const a of saved.behind)
    rows.push({
      kind: "savings",
      id: a.accountId,
      member: { id: a.memberId, memberNo: a.memberNo, nameEn: a.nameEn, nameBn: a.nameBn, phone: "", photoVersion: null },
      no: a.accountNo,
      productCode: a.productCode,
      amount: a.behind,
      since: null,
      late: true,
      paidToday: false,
    });
  return { rows: rows.slice(0, limit), total: rows.length, amount: rows.reduce((s, r) => s + r.amount, 0n) };
}

// ---------- Approvals ----------

export type ApprovalKind = "loan" | "disburse" | "voucher" | "withdrawal" | "exit";

export interface ApprovalItem {
  kind: ApprovalKind;
  id: string;
  /** Where the officer reviews it. */
  href: string;
  /** Member name, or the voucher's narration. */
  nameEn: string | null;
  nameBn: string | null;
  memberNo: number | null;
  amount: bigint;
  at: Date;
  by: { nameEn: string | null; nameBn: string | null };
}

/**
 * Everything waiting on this officer, oldest first: never their own requests,
 * so maker-checker holds here as on each page.
 */
export async function approvalsFor(
  ctx: TenantTx,
  userId: string,
  can: { loans: boolean; disburse: boolean; vouchers: boolean; withdrawals: boolean; exits: boolean },
  limit = 6,
): Promise<{ items: ApprovalItem[]; total: number }> {
  const { tx, tenantId } = ctx;
  const parts = [];
  if (can.loans)
    parts.push(sql`
      select 'loan' as kind, l.id, m.name_en, m.name_bn, m.member_no, l.principal as amount, l.created_at as at, l.applied_by as by_id
        from loan l join member m on m.tenant_id = l.tenant_id and m.id = l.member_id
       where l.tenant_id = ${tenantId} and l.status = 'applied' and l.applied_by <> ${userId}`);
  if (can.disburse)
    parts.push(sql`
      select 'disburse', l.id, m.name_en, m.name_bn, m.member_no, l.principal, coalesce(l.decided_at, l.created_at), l.decided_by
        from loan l join member m on m.tenant_id = l.tenant_id and m.id = l.member_id
       where l.tenant_id = ${tenantId} and l.status = 'approved'`);
  if (can.vouchers)
    parts.push(sql`
      select 'voucher', v.id, v.narration, null, null, v.total, v.created_at, v.created_by
        from voucher v where v.tenant_id = ${tenantId} and v.status = 'pending' and v.created_by <> ${userId}`);
  if (can.withdrawals)
    parts.push(sql`
      select 'withdrawal', w.id, m.name_en, m.name_bn, m.member_no, w.amount, w.created_at, w.requested_by
        from savings_withdrawal w
        join savings_account a on a.tenant_id = w.tenant_id and a.id = w.account_id
        join member m on m.tenant_id = a.tenant_id and m.id = a.member_id
       where w.tenant_id = ${tenantId} and w.status = 'pending' and w.requested_by <> ${userId}`);
  if (can.exits)
    parts.push(sql`
      select 'exit', x.member_id, m.name_en, m.name_bn, m.member_no, coalesce(x.share_refund, 0) + coalesce(x.savings_payout, 0), x.created_at, x.requested_by
        from member_exit x join member m on m.tenant_id = x.tenant_id and m.id = x.member_id
       where x.tenant_id = ${tenantId} and x.status = 'pending' and x.requested_by <> ${userId}`);
  if (!parts.length) return { items: [], total: 0 };

  const res = await tx.execute<{
    kind: ApprovalKind;
    id: string;
    name_en: string | null;
    name_bn: string | null;
    member_no: number | null;
    amount: string;
    at: Date | string;
    by_en: string | null;
    by_bn: string | null;
    total: number;
  }>(sql`
    select q.kind, q.id, q.name_en, q.name_bn, q.member_no, q.amount::text as amount, q.at,
           u.name_en as by_en, u.name_bn as by_bn, count(*) over ()::int as total
      from (${sql.join(parts, sql` union all `)}) q
      left join app_user u on u.tenant_id = ${tenantId} and u.id = q.by_id
     order by q.at
     limit ${limit}`);
  const href: Record<ApprovalKind, (id: string) => string> = {
    loan: (id) => `/loans/${id}`,
    disburse: (id) => `/loans/${id}`,
    voucher: (id) => `/vouchers/${id}`,
    withdrawal: () => `/savings/withdrawals`,
    exit: (id) => `/members/${id}/exit`,
  };
  return {
    total: res.rows[0]?.total ?? 0,
    items: res.rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      href: href[r.kind](r.id),
      nameEn: r.name_en,
      nameBn: r.name_bn,
      memberNo: r.member_no,
      amount: BigInt(r.amount),
      at: new Date(r.at),
      by: { nameEn: r.by_en, nameBn: r.by_bn },
    })),
  };
}

// ---------- Collection target ----------

/** Far above any somiti's month, low enough to catch a slipped digit: 100 crore taka. */
export const MAX_TARGET = 100_000_000_000n;

export type TargetError = "invalid_amount" | "too_large";

/** Sets this month's (and every later month's) collection target; blank clears it. */
export async function setCollectionTarget(
  ctx: TenantTx,
  input: string,
  actor: { userId: string; device?: string },
): Promise<{ ok: true; target: bigint | null } | { ok: false; error: TargetError }> {
  const text = input.trim();
  const target = text ? parseTaka(text) : null;
  if (text && (target === null || target <= 0n)) return { ok: false, error: "invalid_amount" };
  if (target !== null && target > MAX_TARGET) return { ok: false, error: "too_large" };
  const { tx, tenantId } = ctx;
  const [before] = await tx.select({ target: tenant.collectionTarget }).from(tenant).where(eq(tenant.id, tenantId));
  await tx.update(tenant).set({ collectionTarget: target }).where(eq(tenant.id, tenantId));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "somiti.collection_target",
    entityType: "tenant",
    entityId: tenantId,
    before: { target: before?.target?.toString() ?? null },
    after: { target: target?.toString() ?? null },
    device: actor.device,
  });
  return { ok: true, target };
}
