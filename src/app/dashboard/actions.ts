"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { setCollectionTarget, type TargetError } from "@/modules/dashboard";
import { canManageMembers } from "@/modules/members";
import { getCurrentUser } from "../auth";

export interface TargetState {
  error?: TargetError | "not_allowed";
  saved?: boolean;
  /** Bumped on every submit so the same error shows again. */
  attempt?: number;
}

/** The people who run the somiti set what it aims to collect each month. */
export async function setTargetAction(prev: TargetState, form: FormData): Promise<TargetState> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const attempt = (prev.attempt ?? 0) + 1;
  if (!canManageMembers(user.roles)) return { error: "not_allowed", attempt };
  const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
  const r = await withTenant(getAppDb(), user.tenantId, (ctx) =>
    setCollectionTarget(ctx, String(form.get("target") ?? ""), { userId: user.userId, device }),
  );
  if (!r.ok) return { error: r.error, attempt };
  revalidatePath("/dashboard");
  return { saved: true, attempt };
}
