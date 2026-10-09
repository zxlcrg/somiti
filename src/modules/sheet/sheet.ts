import { eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { tenant } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { repayLoan, type RepaymentError } from "@/modules/loans";
import { photoVersion } from "@/modules/members/photos";
import {
  activeAccounts,
  deposit,
  lateFineFor,
  type DepositError,
} from "@/modules/savings";

/*
 * The collection sheet: everything members owe on the business date, one
 * member at a time, as a collector carries it on a round or a cashier works
 * through it at the desk. Savings dues come from each product's schedule,
 * loan dues from the installments fallen due and not yet paid; both are read
 * fresh, like the rest of the app. What was already taken today is shown
 * beside each line, so the sheet doubles as the day's progress.
 *
 * A filled-in sheet can be entered in one go: every amount posts through the
 * same deposit and repayment code as the counter, late fines included, in one
 * transaction, so either the whole sheet is recorded or none of it is.
 */

const notReversed = (alias: string) =>
  sql.raw(
    `not exists (select 1 from journal_entry rev where rev.tenant_id = ${alias}.tenant_id and rev.reverses_id = ${alias}.journal_entry_id)`,
  );

export interface SheetLine {
  kind: "savings" | "loan";
  /** Savings account or loan id. */
  id: string;
  /** Account or loan number. */
  no: number;
  productCode: string;
  /** What falls due on the business date or is behind, without fines. */
  due: bigint;
  /** The late fine paying all of `due` would bring, under today's rules. */
  fine: bigint;
  /** Late (not just due today). */
  late: boolean;
  /** Taken on this line today, fines included. */
  paidToday: bigint;
  /** The regular installment, for the printed sheet. */
  installment: bigint | null;
}

export interface SheetMember {
  id: string;
  memberNo: number;
  nameEn: string | null;
  nameBn: string | null;
  phone: string;
  photoVersion: string | null;
  lines: SheetLine[];
}

export interface CollectionSheet {
  date: string;
  members: SheetMember[];
  totals: {
    due: bigint;
    fine: bigint;
    paidToday: bigint;
    lines: number;
    members: number;
  };
}

export async function collectionSheet(ctx: TenantTx): Promise<CollectionSheet> {
  const { tx, tenantId } = ctx;
  const [somiti] = await tx
    .select({ today: tenant.businessDate })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const today = somiti!.today;

  // Loans: installments due by today and not fully settled; the fine counts late ones not fined before.
  const loans = await tx.execute<{
    id: string;
    loan_no: number;
    code: string;
    member_id: string;
    due: string;
    late: boolean;
    unfined_late: number;
    late_fine: string | null;
    installment: string | null;
    paid_today: string;
  }>(sql`
    with paid as (
      select loan_id, seq, sum(amount) as paid
        from (select x.loan_id, x.seq, x.principal + x.interest + x.rebate as amount
                from loan_repayment_line x where x.tenant_id = ${tenantId}
              union all
              select m.loan_id, m.seq, m.principal + m.interest
                from loan_reschedule_line m where m.tenant_id = ${tenantId}) settled
       group by loan_id, seq
    ), open_inst as (
      select i.loan_id, i.seq, i.due_on, i.principal + i.interest - coalesce(p.paid, 0) as owing
        from loan_installment i
        left join paid p on p.loan_id = i.loan_id and p.seq = i.seq
       where i.tenant_id = ${tenantId} and i.due_on <= ${today}::date
         and i.principal + i.interest > coalesce(p.paid, 0)
    )
    select l.id, l.loan_no, lp.code, l.member_id,
           sum(o.owing)::text as due,
           bool_or(o.due_on < ${today}::date) as late,
           (count(*) filter (where o.due_on < ${today}::date
              and not exists (select 1 from loan_fine f where f.tenant_id = l.tenant_id and f.loan_id = l.id and f.seq = o.seq)))::int as unfined_late,
           l.late_fine::text as late_fine,
           (select (i.principal + i.interest)::text from loan_installment i
             where i.tenant_id = l.tenant_id and i.loan_id = l.id order by i.schedule_no desc, i.seq limit 1) as installment,
           (select coalesce(sum(r.amount + r.fine), 0) from loan_repayment r
             where r.tenant_id = l.tenant_id and r.loan_id = l.id and r.business_date = ${today}::date and ${notReversed("r")})::text as paid_today
      from open_inst o
      join loan l on l.tenant_id = ${tenantId} and l.id = o.loan_id and l.status = 'disbursed'
      join loan_product lp on lp.tenant_id = l.tenant_id and lp.id = l.product_id
     group by l.id, l.loan_no, lp.code, l.member_id, l.late_fine, l.tenant_id`);

  // Loans already paid up today still belong on the sheet, ticked off.
  const paidLoans = await tx.execute<{
    id: string;
    loan_no: number;
    code: string;
    member_id: string;
    paid_today: string;
  }>(sql`
    select l.id, l.loan_no, lp.code, l.member_id, sum(r.amount + r.fine)::text as paid_today
      from loan_repayment r
      join loan l on l.tenant_id = r.tenant_id and l.id = r.loan_id
      join loan_product lp on lp.tenant_id = l.tenant_id and lp.id = l.product_id
     where r.tenant_id = ${tenantId} and r.business_date = ${today}::date and ${notReversed("r")}
     group by l.id, l.loan_no, lp.code, l.member_id`);

  const savingsPaid = await tx.execute<{
    account_id: string;
    paid: string;
  }>(sql`
    select t.account_id, sum(t.amount + coalesce((select f.amount from savings_fine f
             where f.tenant_id = t.tenant_id and f.journal_entry_id = t.journal_entry_id), 0))::text as paid
      from savings_transaction t
     where t.tenant_id = ${tenantId} and t.kind = 'deposit' and t.business_date = ${today}::date and ${notReversed("t")}
     group by t.account_id`);
  const paidByAccount = new Map(
    savingsPaid.rows.map((r) => [r.account_id, BigInt(r.paid)]),
  );

  const lines = new Map<string, SheetLine[]>();
  const add = (memberId: string, line: SheetLine) =>
    lines.set(memberId, [...(lines.get(memberId) ?? []), line]);

  for (const a of await activeAccounts(ctx)) {
    const paidToday = paidByAccount.get(a.id) ?? 0n;
    const behind = a.due && a.due.behind > 0n ? a.due.behind : 0n;
    if (behind === 0n && paidToday === 0n) continue;
    add(a.memberId, {
      kind: "savings",
      id: a.id,
      no: a.accountNo,
      productCode: a.productCode,
      due: behind,
      fine:
        behind > 0n
          ? lateFineFor(
              { installment: a.installment, lateFine: a.lateFine, due: a.due },
              behind,
            ).fine
          : 0n,
      late: (a.due?.overdue ?? 0n) > 0n,
      paidToday,
      installment: a.installment,
    });
  }
  const loanIds = new Set<string>();
  for (const r of loans.rows) {
    loanIds.add(r.id);
    add(r.member_id, {
      kind: "loan",
      id: r.id,
      no: r.loan_no,
      productCode: r.code,
      due: BigInt(r.due),
      fine: r.late_fine ? BigInt(r.late_fine) * BigInt(r.unfined_late) : 0n,
      late: r.late,
      paidToday: BigInt(r.paid_today),
      installment: r.installment === null ? null : BigInt(r.installment),
    });
  }
  for (const r of paidLoans.rows)
    if (!loanIds.has(r.id))
      add(r.member_id, {
        kind: "loan",
        id: r.id,
        no: r.loan_no,
        productCode: r.code,
        due: 0n,
        fine: 0n,
        late: false,
        paidToday: BigInt(r.paid_today),
        installment: null,
      });

  if (!lines.size)
    return {
      date: today,
      members: [],
      totals: { due: 0n, fine: 0n, paidToday: 0n, lines: 0, members: 0 },
    };

  const people = await tx.execute<{
    id: string;
    member_no: number;
    name_en: string | null;
    name_bn: string | null;
    phone: string;
    photo_sha: string | null;
  }>(sql`
    select m.id, m.member_no, m.name_en, m.name_bn, m.phone,
           (select ph.sha256 from member_photo ph where ph.tenant_id = m.tenant_id and ph.member_id = m.id and ph.removed_at is null
             order by ph.created_at desc limit 1) as photo_sha
      from member m
     where m.tenant_id = ${tenantId} and m.status = 'active' and m.id in (${sql.join(
       [...lines.keys()].map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     order by m.member_no`);

  const members: SheetMember[] = people.rows.map((p) => ({
    id: p.id,
    memberNo: p.member_no,
    nameEn: p.name_en,
    nameBn: p.name_bn,
    phone: p.phone,
    photoVersion: p.photo_sha ? photoVersion(p.photo_sha) : null,
    // Loans before savings, then by number, so a member's lines always read in the same order.
    lines: lines
      .get(p.id)!
      .sort((x, y) =>
        x.kind === y.kind ? x.no - y.no : x.kind === "loan" ? -1 : 1,
      ),
  }));
  const all = members.flatMap((m) => m.lines);
  return {
    date: today,
    members,
    totals: {
      due: all.reduce((s, l) => s + l.due, 0n),
      fine: all.reduce((s, l) => s + l.fine, 0n),
      paidToday: all.reduce((s, l) => s + l.paidToday, 0n),
      lines: all.filter((l) => l.due > 0n).length,
      members: members.filter((m) => m.lines.some((l) => l.due > 0n)).length,
    },
  };
}

// ---------- Entering a filled-in sheet ----------

export interface SheetEntry {
  kind: "savings" | "loan";
  id: string;
  /** Typed taka, without the fine; Bangla digits are fine. Blank lines are skipped. */
  amount: string;
}

export type SheetLineError = DepositError | RepaymentError | "invalid_amount";

export type RecordSheetResult =
  | { ok: true; count: number; amount: bigint; fines: bigint }
  | {
      ok: false;
      errors: Record<string, SheetLineError>;
      form?: "empty" | "too_many";
    };

/** One sheet holds at most this many payments; past it, enter the rest on a second sheet. */
export const MAX_SHEET_LINES = 200;

class SheetRejected extends Error {
  constructor(readonly errors: Record<string, SheetLineError>) {
    super("sheet rejected");
  }
}

export const lineKey = (e: { kind: "savings" | "loan"; id: string }) =>
  `${e.kind === "savings" ? "s" : "l"}:${e.id}`;

/**
 * Posts every filled line as cash taken by this officer: at the office for a
 * cashier, into the collector's bag for a field collector. `sheetKey` is made
 * once per sheet, so submitting the same sheet twice records it once.
 * The lines post inside a savepoint: one refused line rolls them all back.
 */
export async function recordSheet(
  ctx: TenantTx,
  entries: SheetEntry[],
  sheetKey: string,
  actor: { userId: string; channel: "office" | "collector"; device?: string },
): Promise<RecordSheetResult> {
  const filled = entries.filter((e) => e.amount.trim());
  if (!filled.length) return { ok: false, errors: {}, form: "empty" };
  if (filled.length > MAX_SHEET_LINES)
    return { ok: false, errors: {}, form: "too_many" };
  const errors: Record<string, SheetLineError> = {};
  for (const e of filled) {
    const amount = parseTaka(e.amount);
    if (amount === null || amount <= 0n) errors[lineKey(e)] = "invalid_amount";
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  try {
    return await ctx.tx.transaction(async (inner) => {
      const sp = { tx: inner, tenantId: ctx.tenantId } as TenantTx;
      let amount = 0n;
      let fines = 0n;
      for (const e of filled) {
        const key = `sheet:${sheetKey}:${lineKey(e)}`;
        if (e.kind === "savings") {
          const r = await deposit(
            sp,
            {
              accountId: e.id,
              amount: e.amount,
              method: "cash",
              idempotencyKey: key,
            },
            actor,
          );
          if (!r.ok)
            throw new SheetRejected({
              [lineKey(e)]: Object.values(r.errors)[0]!,
            });
          amount += r.deposit.amount;
          fines += r.deposit.fine ?? 0n;
        } else {
          const r = await repayLoan(
            sp,
            {
              loanId: e.id,
              amount: e.amount,
              method: "cash",
              idempotencyKey: key,
            },
            actor,
          );
          if (!r.ok)
            throw new SheetRejected({
              [lineKey(e)]: Object.values(r.errors)[0]!,
            });
          amount += r.repayment.amount;
          fines += r.repayment.fine;
        }
      }
      return { ok: true as const, count: filled.length, amount, fines };
    });
  } catch (err) {
    if (err instanceof SheetRejected) return { ok: false, errors: err.errors };
    throw err;
  }
}
