import { and, eq } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { ledgerAccount } from "@/db/schema";
import { DEFAULT_CHART } from "@/modules/ledger";

/** Somitis created before the import existed lack account 3900; add it from the default chart. */
export async function ensureOpeningEquity(ctx: TenantTx): Promise<void> {
  const spec = DEFAULT_CHART.find((a) => a.systemKey === "opening_balance_equity")!;
  const [parent] = await ctx.tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, ctx.tenantId), eq(ledgerAccount.code, spec.parent!)));
  await ctx.tx
    .insert(ledgerAccount)
    .values({
      tenantId: ctx.tenantId,
      code: spec.code,
      nameEn: spec.nameEn,
      nameBn: spec.nameBn,
      type: spec.type,
      parentId: parent?.id ?? null,
      systemKey: spec.systemKey,
    })
    .onConflictDoNothing();
}
