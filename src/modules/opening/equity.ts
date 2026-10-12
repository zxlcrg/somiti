import type { TenantTx } from "@/db/client";
import { ensureChartAccount } from "@/modules/ledger";

/** Somitis created before the import existed lack account 3900; add it from the default chart. */
export async function ensureOpeningEquity(ctx: TenantTx): Promise<void> {
  await ensureChartAccount(ctx, "opening_balance_equity");
}
