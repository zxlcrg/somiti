import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, shareTransaction, tenant } from "@/db/schema";
import { toLatinDigits } from "@/lib/digits";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, postEntry } from "@/modules/ledger";

export const PAYMENT_METHODS = ["cash", "bank", "mobile_wallet"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const MAX_SHARES_PER_PURCHASE = 10_000;

/** Which ledger account the money lands in, by how it was paid. */
const ACCOUNT_FOR: Record<PaymentMethod, "cash_in_hand" | "bank" | "mobile_wallet"> = {
  cash: "cash_in_hand",
  bank: "bank",
  mobile_wallet: "mobile_wallet",
};

export interface BuySharesInput {
  memberId: string;
  /** Typed count; Bangla digits are fine. */
  shares: string | number;
  method: string;
  /** Bank slip or bKash/Nagad transaction ID; required for mobile wallets. */
  paymentRef?: string;
  /** Generated once per form, so a double submit or a retry posts once. */
  idempotencyKey: string;
}

export interface ShareTxnView {
  id: string;
  kind: "purchase";
  shares: number;
  price: bigint;
  amount: bigint;
  paymentMethod: PaymentMethod;
  paymentRef: string | null;
  businessDate: string;
  createdAt: Date;
  journalEntryId: string;
  /** Voucher number of the entry; printed as the receipt number. */
  entryNo: bigint;
  /** True when the entry was reversed in the ledger; it then doesn't count. */
  reversed: boolean;
}

export type BuySharesError =
  | "invalid_shares"
  | "invalid_method"
  | "ref_required"
  | "ref_too_long"
  | "member_inactive"
  | "not_found";

export type BuySharesResult =
  | { ok: true; purchase: ShareTxnView; replayed: boolean }
  | { ok: false; errors: Partial<Record<"shares" | "method" | "paymentRef" | "form", BuySharesError>> };

export function parseShareCount(input: string | number): number | null {
  const text = toLatinDigits(String(input)).trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_SHARES_PER_PURCHASE ? n : null;
}

export async function sharePrice({ tx, tenantId }: TenantTx): Promise<bigint> {
  const [row] = await tx.select({ price: tenant.sharePrice }).from(tenant).where(eq(tenant.id, tenantId));
  if (!row) throw new Error("Unknown somiti");
  return row.price;
}

const txnColumns = {
  id: shareTransaction.id,
  kind: shareTransaction.kind,
  shares: shareTransaction.shares,
  price: shareTransaction.price,
  amount: shareTransaction.amount,
  paymentMethod: shareTransaction.paymentMethod,
  paymentRef: shareTransaction.paymentRef,
  businessDate: shareTransaction.businessDate,
  createdAt: shareTransaction.createdAt,
  journalEntryId: shareTransaction.journalEntryId,
  // Read through subqueries: only the ledger module touches journal tables in code.
  entryNo: sql<bigint>`(
    select je.entry_no from journal_entry je
     where je.tenant_id = "share_transaction"."tenant_id" and je.id = "share_transaction"."journal_entry_id"
  )`.mapWith((v: string | number) => BigInt(v)),
  reversed: sql<boolean>`exists (
    select 1 from journal_entry r
     where r.tenant_id = "share_transaction"."tenant_id" and r.reverses_id = "share_transaction"."journal_entry_id"
  )`,
};

async function transactionByEntry({ tx, tenantId }: TenantTx, entryId: string): Promise<ShareTxnView | undefined> {
  const [row] = await tx
    .select(txnColumns)
    .from(shareTransaction)
    .where(and(eq(shareTransaction.tenantId, tenantId), eq(shareTransaction.journalEntryId, entryId)));
  return row;
}

/**
 * Sells shares to an active member at the somiti's share price: posts
 * Dr cash/bank/wallet, Cr share capital (on the member's line) and records
 * the count. Ledger rules (open day, open fiscal year) apply as for any
 * posting and surface as LedgerError.
 */
export async function buyShares(
  ctx: TenantTx,
  input: BuySharesInput,
  actor: { userId: string; device?: string },
): Promise<BuySharesResult> {
  const errors: Partial<Record<"shares" | "method" | "paymentRef" | "form", BuySharesError>> = {};
  const shares = parseShareCount(input.shares);
  if (shares === null) errors.shares = "invalid_shares";
  const method = PAYMENT_METHODS.find((m) => m === input.method);
  if (!method) errors.method = "invalid_method";
  const paymentRef = input.paymentRef?.trim() || null;
  if (method === "mobile_wallet" && !paymentRef) errors.paymentRef = "ref_required";
  if (paymentRef && paymentRef.length > 64) errors.paymentRef = "ref_too_long";
  if (Object.keys(errors).length) return { ok: false, errors };

  const { tx, tenantId } = ctx;
  const [owner] = await tx
    .select({ status: member.status, branchId: member.branchId, memberNo: member.memberNo })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, input.memberId)));
  if (!owner) return { ok: false, errors: { form: "not_found" } };
  if (owner.status !== "active") return { ok: false, errors: { form: "member_inactive" } };

  const price = await sharePrice(ctx);
  const amount = BigInt(shares!) * price;
  const accounts = await accountIdsByKey(ctx, [ACCOUNT_FOR[method!], "share_capital"] as const);

  const posted = await postEntry(ctx, {
    branchId: owner.branchId,
    source: "share_purchase",
    narration: `Share purchase: ${shares} × ${price / 100n} taka, member #${owner.memberNo}${paymentRef ? `, ref ${paymentRef}` : ""}`,
    createdBy: actor.userId,
    idempotencyKey: input.idempotencyKey,
    device: actor.device,
    lines: [
      { accountId: accounts[ACCOUNT_FOR[method!]], debit: amount },
      { accountId: accounts.share_capital, credit: amount, memberId: input.memberId },
    ],
  });

  if (posted.replayed) {
    const earlier = await transactionByEntry(ctx, posted.entry.id);
    if (earlier) return { ok: true, purchase: earlier, replayed: true };
  }

  await tx.insert(shareTransaction).values({
    tenantId,
    memberId: input.memberId,
    kind: "purchase",
    shares: shares!,
    price,
    amount,
    paymentMethod: method!,
    paymentRef,
    journalEntryId: posted.entry.id,
    businessDate: posted.entry.businessDate,
    createdBy: actor.userId,
  });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "member.shares.buy",
    entityType: "member",
    entityId: input.memberId,
    after: { shares, price, amount, paymentMethod: method, paymentRef, entryNo: posted.entry.entryNo },
    device: actor.device,
  });
  return { ok: true, purchase: (await transactionByEntry(ctx, posted.entry.id))!, replayed: false };
}

export interface ShareHolding {
  shares: number;
  amount: bigint;
  /** Newest first, reversed ones included and flagged. */
  transactions: ShareTxnView[];
}

export async function shareHolding({ tx, tenantId }: TenantTx, memberId: string): Promise<ShareHolding> {
  const transactions = await tx
    .select(txnColumns)
    .from(shareTransaction)
    .where(and(eq(shareTransaction.tenantId, tenantId), eq(shareTransaction.memberId, memberId)))
    .orderBy(desc(shareTransaction.createdAt));
  const counted = transactions.filter((t) => !t.reversed);
  return {
    shares: counted.reduce((sum, t) => sum + t.shares, 0),
    amount: counted.reduce((sum, t) => sum + t.amount, 0n),
    transactions,
  };
}
