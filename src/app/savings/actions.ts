"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { canManageSavings, setLateFine, setProductActive } from "@/modules/savings";
import { getCurrentUser } from "../auth";

export async function setProductActiveAction(productId: string, active: boolean): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageSavings(user.roles)) return;
  const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
  await withTenant(getAppDb(), user.tenantId, (ctx) => setProductActive(ctx, productId, active, { userId: user.userId, device }));
  revalidatePath("/savings");
}

export interface LateFineState {
  error?: "invalid_amount" | "too_large" | "flexible" | "not_found" | "forbidden" | "server";
  saved?: number;
  attempt?: number;
}

export async function setLateFineAction(productId: string, prev: LateFineState, form: FormData): Promise<LateFineState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageSavings(user.roles)) return { error: "forbidden", attempt };
  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      setLateFine(ctx, productId, String(form.get("lateFine") ?? ""), { userId: user.userId, device }),
    );
  } catch (err) {
    console.error(err);
    return { error: "server", attempt };
  }
  if (!result.ok) return { error: result.error, attempt };
  revalidatePath("/savings");
  return { saved: attempt, attempt };
}
