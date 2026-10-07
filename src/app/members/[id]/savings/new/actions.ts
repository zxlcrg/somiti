"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { canManageSavings, openAccount, type OpenAccountError } from "@/modules/savings";
import { getCurrentUser } from "../../../../auth";

export interface OpenAccountState {
  errors?: Partial<Record<"productId" | "installment", OpenAccountError>> & { form?: OpenAccountError | "forbidden" | "server" };
  attempt?: number;
}

export async function openAccountAction(memberId: string, prev: OpenAccountState, form: FormData): Promise<OpenAccountState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageSavings(user.roles)) return { errors: { form: "forbidden" }, attempt };

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      openAccount(
        ctx,
        { memberId, productId: String(form.get("productId") ?? ""), installment: String(form.get("installment") ?? "") },
        { userId: user.userId, device },
      ),
    );
  } catch (err) {
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  redirect(`/savings/accounts/${result.accountId}?opened=1`);
}
