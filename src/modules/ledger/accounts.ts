import { and, eq, inArray } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { ledgerAccount } from "@/db/schema";
import { LedgerError } from "./errors";

/** Looks up accounts by system key ("cash_in_hand", "member_savings", ...). */
export async function accountIdsByKey<K extends string>(
  ctx: TenantTx,
  keys: readonly K[],
): Promise<Record<K, string>> {
  const rows = await ctx.tx
    .select({ id: ledgerAccount.id, systemKey: ledgerAccount.systemKey })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, ctx.tenantId), inArray(ledgerAccount.systemKey, [...keys])));
  const result = {} as Record<K, string>;
  for (const key of keys) {
    const row = rows.find((r) => r.systemKey === key);
    if (!row) throw new LedgerError("NOT_FOUND", `No account with system key ${key}`);
    result[key] = row.id;
  }
  return result;
}
