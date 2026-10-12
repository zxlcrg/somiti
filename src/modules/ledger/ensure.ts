import { and, eq } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { ledgerAccount } from "@/db/schema";
import { DEFAULT_CHART } from "./default-chart";

/** Somitis created before an account joined the default chart lack it; add it, under its usual parent. */
export async function ensureChartAccount(ctx: TenantTx, systemKey: string): Promise<void> {
  const spec = DEFAULT_CHART.find((a) => a.systemKey === systemKey);
  if (!spec) throw new Error(`no default account for ${systemKey}`);
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
