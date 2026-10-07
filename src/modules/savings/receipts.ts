import { and, eq } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, savingsTransaction, tenant } from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { smsStateFor, type SmsState } from "@/modules/messages";
import { getAccount, type SavingsAccountView, type SavingsTxnView } from "./accounts";

export interface Receipt {
  txn: SavingsTxnView;
  account: SavingsAccountView;
  member: { id: string; memberNo: number; nameEn: string | null; nameBn: string | null; phone: string };
  somiti: { nameEn: string | null; nameBn: string | null };
  /** The member's language for printed and texted receipts. */
  memberLocale: Locale;
  /** Null when no message was queued for this movement. */
  sms: SmsState | null;
}

/** Everything a printed receipt (deposit) or payment slip (withdrawal) shows. */
export async function getReceipt(ctx: TenantTx, txnId: string): Promise<Receipt | null> {
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .select({ accountId: savingsTransaction.accountId })
    .from(savingsTransaction)
    .where(and(eq(savingsTransaction.tenantId, tenantId), eq(savingsTransaction.id, txnId)));
  if (!row) return null;
  const account = await getAccount(ctx, row.accountId);
  const txn = account?.transactions.find((x) => x.id === txnId);
  // Opening balances moved no money, so there is nothing to give the member a receipt for.
  if (!account || !txn || txn.kind === "opening") return null;
  const [m] = await tx
    .select({
      id: member.id,
      memberNo: member.memberNo,
      nameEn: member.nameEn,
      nameBn: member.nameBn,
      phone: member.phone,
      commLocale: member.commLocale,
      somitiEn: tenant.nameEn,
      somitiBn: tenant.nameBn,
      defaultLocale: tenant.defaultLocale,
    })
    .from(member)
    .innerJoin(tenant, eq(tenant.id, member.tenantId))
    .where(and(eq(member.tenantId, tenantId), eq(member.id, account.memberId)));
  const sms = await smsStateFor(ctx, [txn.journalEntryId]);
  return {
    txn,
    account,
    member: { id: m!.id, memberNo: m!.memberNo, nameEn: m!.nameEn, nameBn: m!.nameBn, phone: m!.phone },
    somiti: { nameEn: m!.somitiEn, nameBn: m!.somitiBn },
    memberLocale: m!.commLocale ?? m!.defaultLocale,
    sms: sms.get(txn.journalEntryId) ?? null,
  };
}
