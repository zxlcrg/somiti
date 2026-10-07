import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, savingsAccount, savingsProduct, savingsTransaction, tenant } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, postEntry } from "@/modules/ledger";
import { dueStatus, type DueStatus, type SavingsFrequency } from "./schedule";

export const DEPOSIT_METHODS = ["cash", "bank", "mobile_wallet"] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export type DepositChannel = "office" | "collector";
/** ৳10,00,000 in one deposit is past anything a somiti counter takes in cash. */
export const MAX_DEPOSIT = 10_00_000_00n;

const ACCOUNT_FOR: Record<DepositMethod, "cash_in_hand" | "bank" | "mobile_wallet"> = {
  cash: "cash_in_hand",
  bank: "bank",
  mobile_wallet: "mobile_wallet",
};

async function businessDate({ tx, tenantId }: TenantTx): Promise<string> {
  const [row] = await tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  if (!row) throw new Error("Unknown somiti");
  return row.d;
}

// ---------- Opening an account ----------

export type OpenAccountError = "invalid_product" | "product_inactive" | "already_open" | "member_inactive" | "not_found" | "invalid_amount";

export async function openAccount(
  ctx: TenantTx,
  input: { memberId: string; productId: string; installment?: string },
  actor: { userId: string; device?: string },
): Promise<{ ok: true; accountId: string; accountNo: number } | { ok: false; errors: Partial<Record<"productId" | "installment" | "form", OpenAccountError>> }> {
  const { tx, tenantId } = ctx;
  const [owner] = await tx
    .select({ status: member.status })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, input.memberId)));
  if (!owner) return { ok: false, errors: { form: "not_found" } };
  if (owner.status !== "active") return { ok: false, errors: { form: "member_inactive" } };

  const [product] = await tx
    .select({ id: savingsProduct.id, active: savingsProduct.active, frequency: savingsProduct.frequency, installment: savingsProduct.installment })
    .from(savingsProduct)
    .where(and(eq(savingsProduct.tenantId, tenantId), eq(savingsProduct.id, input.productId)));
  if (!product) return { ok: false, errors: { productId: "invalid_product" } };
  if (!product.active) return { ok: false, errors: { productId: "product_inactive" } };

  // A member may agree a bigger installment than the product's (never on a flexible product).
  let installment = product.installment;
  const typed = input.installment?.trim();
  if (typed && product.frequency !== "flexible") {
    const paisa = parseTaka(typed);
    if (paisa === null || paisa <= 0n || paisa > MAX_DEPOSIT) return { ok: false, errors: { installment: "invalid_amount" } };
    installment = paisa;
  }

  // Account numbers are gap-free per somiti; openings take turns for the next one.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`savings_account_no:${tenantId}`}))`);
  const [open] = await tx
    .select({ id: savingsAccount.id })
    .from(savingsAccount)
    .where(
      and(
        eq(savingsAccount.tenantId, tenantId),
        eq(savingsAccount.memberId, input.memberId),
        eq(savingsAccount.productId, product.id),
        eq(savingsAccount.status, "active"),
      ),
    );
  if (open) return { ok: false, errors: { productId: "already_open" } };
  const [last] = await tx
    .select({ n: sql<number>`coalesce(max(${savingsAccount.accountNo}), 0)` })
    .from(savingsAccount)
    .where(eq(savingsAccount.tenantId, tenantId));
  const accountNo = Number(last?.n ?? 0) + 1;
  const openedOn = await businessDate(ctx);

  const [row] = await tx
    .insert(savingsAccount)
    .values({ tenantId, accountNo, memberId: input.memberId, productId: product.id, installment, openedOn, openedBy: actor.userId })
    .returning({ id: savingsAccount.id });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "savings.account.open",
    entityType: "savings_account",
    entityId: row!.id,
    after: { accountNo, memberId: input.memberId, productId: product.id, installment: installment?.toString() ?? null, openedOn },
    device: actor.device,
  });
  return { ok: true, accountId: row!.id, accountNo };
}

// ---------- Reading accounts ----------

export interface SavingsTxnView {
  id: string;
  kind: "deposit" | "withdrawal";
  /** Always positive; `kind` says which way it went. */
  amount: bigint;
  channel: DepositChannel;
  paymentMethod: DepositMethod;
  paymentRef: string | null;
  businessDate: string;
  createdAt: Date;
  journalEntryId: string;
  /** Voucher number of the entry, printed as the receipt or payment number. */
  entryNo: bigint;
  reversed: boolean;
  /** Running balance after this row, counting only rows that still count. */
  balanceAfter: bigint;
  takenBy: { nameEn: string | null; nameBn: string | null };
}

export interface SavingsAccountView {
  id: string;
  accountNo: number;
  memberId: string;
  productId: string;
  productCode: string;
  productNameEn: string;
  productNameBn: string | null;
  frequency: SavingsFrequency;
  installment: bigint | null;
  minDeposit: bigint;
  openedOn: string;
  status: "active" | "closed";
  balance: bigint;
  /** Everything ever deposited (not net of withdrawals); dues are measured against this. */
  deposited: bigint;
  deposits: number;
  lastDepositOn: string | null;
  due: DueStatus | null;
}

/** Deposits add, withdrawals take away. */
const signed = sql`case when t.kind = 'withdrawal' then -t.amount else t.amount end`;
const counts = sql`not exists (select 1 from journal_entry r where r.tenant_id = t.tenant_id and r.reverses_id = t.journal_entry_id)`;

async function accountRows(ctx: TenantTx, where: ReturnType<typeof and>): Promise<SavingsAccountView[]> {
  const asOf = await businessDate(ctx);
  const rows = await ctx.tx
    .select({
      id: savingsAccount.id,
      accountNo: savingsAccount.accountNo,
      memberId: savingsAccount.memberId,
      productId: savingsAccount.productId,
      productCode: savingsProduct.code,
      productNameEn: savingsProduct.nameEn,
      productNameBn: savingsProduct.nameBn,
      frequency: savingsProduct.frequency,
      installment: savingsAccount.installment,
      minDeposit: savingsProduct.minDeposit,
      openedOn: savingsAccount.openedOn,
      status: savingsAccount.status,
      balance: sql<string>`(
        select coalesce(sum(${signed}), 0) from savings_transaction t
         where t.tenant_id = "savings_account"."tenant_id" and t.account_id = "savings_account"."id" and ${counts}
      )`.mapWith((v: string | number) => BigInt(v)),
      deposited: sql<string>`(
        select coalesce(sum(t.amount), 0) from savings_transaction t
         where t.tenant_id = "savings_account"."tenant_id" and t.account_id = "savings_account"."id"
           and t.kind = 'deposit' and ${counts}
      )`.mapWith((v: string | number) => BigInt(v)),
      deposits: sql<number>`(
        select count(*)::int from savings_transaction t
         where t.tenant_id = "savings_account"."tenant_id" and t.account_id = "savings_account"."id"
           and t.kind = 'deposit' and ${counts}
      )`,
      lastDepositOn: sql<string | null>`(
        select max(t.business_date)::text from savings_transaction t
         where t.tenant_id = "savings_account"."tenant_id" and t.account_id = "savings_account"."id"
           and t.kind = 'deposit' and ${counts}
      )`,
    })
    .from(savingsAccount)
    .innerJoin(
      savingsProduct,
      and(eq(savingsProduct.tenantId, savingsAccount.tenantId), eq(savingsProduct.id, savingsAccount.productId)),
    )
    .where(where)
    .orderBy(asc(savingsAccount.accountNo));
  return rows.map((r) => ({
    ...(r as Omit<SavingsAccountView, "due">),
    due: r.status === "active" ? dueStatus(r.frequency, r.installment, r.openedOn, asOf, r.deposited as bigint) : null,
  }));
}

export async function memberAccounts(ctx: TenantTx, memberId: string): Promise<SavingsAccountView[]> {
  return accountRows(ctx, and(eq(savingsAccount.tenantId, ctx.tenantId), eq(savingsAccount.memberId, memberId)));
}

export async function getAccount(
  ctx: TenantTx,
  accountId: string,
): Promise<(SavingsAccountView & { transactions: SavingsTxnView[] }) | null> {
  const [account] = await accountRows(ctx, and(eq(savingsAccount.tenantId, ctx.tenantId), eq(savingsAccount.id, accountId)));
  if (!account) return null;
  const rows = await ctx.tx
    .select({
      id: savingsTransaction.id,
      kind: savingsTransaction.kind,
      amount: savingsTransaction.amount,
      channel: savingsTransaction.channel,
      paymentMethod: savingsTransaction.paymentMethod,
      paymentRef: savingsTransaction.paymentRef,
      businessDate: savingsTransaction.businessDate,
      createdAt: savingsTransaction.createdAt,
      journalEntryId: savingsTransaction.journalEntryId,
      entryNo: sql<string>`(
        select je.entry_no from journal_entry je
         where je.tenant_id = "savings_transaction"."tenant_id" and je.id = "savings_transaction"."journal_entry_id"
      )`.mapWith((v: string | number) => BigInt(v)),
      reversed: sql<boolean>`exists (
        select 1 from journal_entry r
         where r.tenant_id = "savings_transaction"."tenant_id" and r.reverses_id = "savings_transaction"."journal_entry_id"
      )`,
      takenByEn: sql<string | null>`(select u.name_en from app_user u where u.tenant_id = "savings_transaction"."tenant_id" and u.id = "savings_transaction"."created_by")`,
      takenByBn: sql<string | null>`(select u.name_bn from app_user u where u.tenant_id = "savings_transaction"."tenant_id" and u.id = "savings_transaction"."created_by")`,
    })
    .from(savingsTransaction)
    .where(and(eq(savingsTransaction.tenantId, ctx.tenantId), eq(savingsTransaction.accountId, accountId)))
    .orderBy(asc(savingsTransaction.createdAt), asc(savingsTransaction.id));

  let running = 0n;
  const transactions: SavingsTxnView[] = rows.map(({ takenByEn, takenByBn, ...r }) => {
    if (!r.reversed) running += r.kind === "withdrawal" ? -r.amount : r.amount;
    return { ...(r as Omit<SavingsTxnView, "balanceAfter" | "takenBy">), balanceAfter: running, takenBy: { nameEn: takenByEn, nameBn: takenByBn } };
  });
  return { ...account, transactions: transactions.reverse() };
}

// ---------- Deposits ----------

export interface DepositInput {
  accountId: string;
  /** Typed taka; Bangla digits are fine. */
  amount: string;
  method: string;
  paymentRef?: string;
  /** Generated once per form, so a double submit or a retry posts once. */
  idempotencyKey: string;
}

export type DepositError =
  | "invalid_amount"
  | "below_minimum"
  | "too_large"
  | "invalid_method"
  | "collector_cash_only"
  | "ref_required"
  | "ref_too_long"
  | "account_closed"
  | "member_inactive"
  | "not_found";

export type DepositResult =
  | { ok: true; deposit: SavingsTxnView; replayed: boolean }
  | { ok: false; errors: Partial<Record<"amount" | "method" | "paymentRef" | "form", DepositError>> };

/**
 * Takes a deposit into a savings account: posts Dr cash in hand, bank or
 * wallet (or Cash with collector for a collector's round), Cr Member
 * savings on the member's line. Ledger rules (open day, open fiscal year)
 * apply as for any posting and surface as LedgerError.
 */
export async function deposit(
  ctx: TenantTx,
  input: DepositInput,
  actor: { userId: string; channel: DepositChannel; device?: string },
): Promise<DepositResult> {
  const errors: Partial<Record<"amount" | "method" | "paymentRef" | "form", DepositError>> = {};
  const amount = parseTaka(input.amount);
  if (amount === null || amount <= 0n) errors.amount = "invalid_amount";
  else if (amount > MAX_DEPOSIT) errors.amount = "too_large";
  const method = DEPOSIT_METHODS.find((m) => m === input.method);
  if (!method) errors.method = "invalid_method";
  else if (actor.channel === "collector" && method !== "cash") errors.method = "collector_cash_only";
  const paymentRef = input.paymentRef?.trim() || null;
  if (method === "mobile_wallet" && !paymentRef) errors.paymentRef = "ref_required";
  if (paymentRef && paymentRef.length > 64) errors.paymentRef = "ref_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  const { tx, tenantId } = ctx;
  const [account] = await tx
    .select({
      accountNo: savingsAccount.accountNo,
      status: savingsAccount.status,
      memberId: savingsAccount.memberId,
      memberNo: member.memberNo,
      memberStatus: member.status,
      branchId: member.branchId,
      minDeposit: savingsProduct.minDeposit,
      productCode: savingsProduct.code,
    })
    .from(savingsAccount)
    .innerJoin(member, and(eq(member.tenantId, savingsAccount.tenantId), eq(member.id, savingsAccount.memberId)))
    .innerJoin(savingsProduct, and(eq(savingsProduct.tenantId, savingsAccount.tenantId), eq(savingsProduct.id, savingsAccount.productId)))
    .where(and(eq(savingsAccount.tenantId, tenantId), eq(savingsAccount.id, input.accountId)));
  if (!account) return { ok: false, errors: { form: "not_found" } };
  if (account.status !== "active") return { ok: false, errors: { form: "account_closed" } };
  if (account.memberStatus !== "active") return { ok: false, errors: { form: "member_inactive" } };
  if (amount! < account.minDeposit) return { ok: false, errors: { amount: "below_minimum" } };

  const debitKey = actor.channel === "collector" ? "cash_with_collector" : ACCOUNT_FOR[method!];
  const accounts = await accountIdsByKey(ctx, [debitKey, "member_savings"] as const);
  const posted = await postEntry(ctx, {
    branchId: account.branchId,
    source: "savings_deposit",
    narration: `Savings deposit: ${account.productCode} account #${account.accountNo}, member #${account.memberNo}${paymentRef ? `, ref ${paymentRef}` : ""}`,
    createdBy: actor.userId,
    idempotencyKey: input.idempotencyKey,
    device: actor.device,
    lines: [
      { accountId: accounts[debitKey], debit: amount! },
      { accountId: accounts.member_savings, credit: amount!, memberId: account.memberId },
    ],
  });

  const find = async () => {
    const view = await getAccount(ctx, input.accountId);
    return view?.transactions.find((x) => x.journalEntryId === posted.entry.id);
  };
  if (posted.replayed) {
    const earlier = await find();
    if (earlier) return { ok: true, deposit: earlier, replayed: true };
  }

  await tx.insert(savingsTransaction).values({
    tenantId,
    accountId: input.accountId,
    kind: "deposit",
    amount: amount!,
    channel: actor.channel,
    paymentMethod: method!,
    paymentRef,
    journalEntryId: posted.entry.id,
    businessDate: posted.entry.businessDate,
    createdBy: actor.userId,
  });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "savings.deposit",
    entityType: "savings_account",
    entityId: input.accountId,
    after: { amount: amount!.toString(), channel: actor.channel, paymentMethod: method, paymentRef, entryNo: posted.entry.entryNo },
    device: actor.device,
  });
  return { ok: true, deposit: (await find())!, replayed: false };
}

// ---------- Overview ----------

export interface SavingsOverview {
  totalBalance: bigint;
  openAccounts: number;
  todayCount: number;
  todayAmount: bigint;
  /** Scheduled accounts behind on their installments, worst first. */
  behind: { accountId: string; accountNo: number; memberId: string; memberNo: number; nameEn: string | null; nameBn: string | null; productCode: string; behind: bigint }[];
  /** Deposits by business day over the last 14 days, oldest first. */
  daily: { date: string; amount: bigint; count: number }[];
}

export async function savingsOverview(ctx: TenantTx): Promise<SavingsOverview> {
  const { tx, tenantId } = ctx;
  const asOf = await businessDate(ctx);
  const accounts = await accountRows(ctx, and(eq(savingsAccount.tenantId, tenantId), eq(savingsAccount.status, "active")));
  const late = accounts
    .filter((a) => a.due && a.due.behind > 0n)
    .sort((x, y) => (y.due!.behind > x.due!.behind ? 1 : y.due!.behind < x.due!.behind ? -1 : 0))
    .slice(0, 8);
  const names = late.length
    ? await tx
        .select({ id: member.id, memberNo: member.memberNo, nameEn: member.nameEn, nameBn: member.nameBn })
        .from(member)
        .where(and(eq(member.tenantId, tenantId), inArray(member.id, late.map((a) => a.memberId))))
    : [];
  const byId = new Map(names.map((n) => [n.id, n]));

  const daily = await tx.execute<{ date: string; amount: string; count: number }>(sql`
    select d::date::text as date, coalesce(sum(t.amount), 0)::text as amount, count(t.id)::int as count
      from generate_series(${asOf}::date - 13, ${asOf}::date, interval '1 day') d
      left join savings_transaction t
        on t.tenant_id = ${tenantId} and t.business_date = d::date and t.kind = 'deposit' and ${counts}
     group by d order by d`);
  const series = daily.rows.map((r) => ({ date: r.date, amount: BigInt(r.amount), count: Number(r.count) }));
  const today = series[series.length - 1] ?? { amount: 0n, count: 0 };

  return {
    totalBalance: accounts.reduce((s, a) => s + a.balance, 0n),
    openAccounts: accounts.length,
    todayCount: today.count,
    todayAmount: today.amount,
    behind: late.map((a) => {
        const m = byId.get(a.memberId);
        return {
          accountId: a.id,
          accountNo: a.accountNo,
          memberId: a.memberId,
          memberNo: m?.memberNo ?? 0,
          nameEn: m?.nameEn ?? null,
          nameBn: m?.nameBn ?? null,
          productCode: a.productCode,
          behind: a.due!.behind,
        };
    }),
    daily: series,
  };
}

/** Newest deposits across the somiti, for the savings page. */
export async function recentDeposits(ctx: TenantTx, limit = 8) {
  const { tx, tenantId } = ctx;
  return tx
    .select({
      id: savingsTransaction.id,
      accountId: savingsTransaction.accountId,
      amount: savingsTransaction.amount,
      channel: savingsTransaction.channel,
      paymentMethod: savingsTransaction.paymentMethod,
      createdAt: savingsTransaction.createdAt,
      accountNo: savingsAccount.accountNo,
      memberId: member.id,
      memberNo: member.memberNo,
      nameEn: member.nameEn,
      nameBn: member.nameBn,
    })
    .from(savingsTransaction)
    .innerJoin(savingsAccount, and(eq(savingsAccount.tenantId, savingsTransaction.tenantId), eq(savingsAccount.id, savingsTransaction.accountId)))
    .innerJoin(member, and(eq(member.tenantId, savingsAccount.tenantId), eq(member.id, savingsAccount.memberId)))
    .where(and(eq(savingsTransaction.tenantId, tenantId), eq(savingsTransaction.kind, "deposit")))
    .orderBy(desc(savingsTransaction.createdAt))
    .limit(limit);
}
