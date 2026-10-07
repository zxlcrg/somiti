"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { canManageSavings, setProductActive } from "@/modules/savings";
import { getCurrentUser } from "../auth";

export async function setProductActiveAction(productId: string, active: boolean): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageSavings(user.roles)) return;
  const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
  await withTenant(getAppDb(), user.tenantId, (ctx) => setProductActive(ctx, productId, active, { userId: user.userId, device }));
  revalidatePath("/savings");
}
