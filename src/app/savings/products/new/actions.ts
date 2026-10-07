"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { canManageSavings, createProduct, type ProductErrors } from "@/modules/savings";
import { getCurrentUser } from "../../../auth";

export interface ProductFormState {
  errors?: ProductErrors & { form?: "forbidden" | "server" };
  attempt?: number;
}

export async function createProductAction(prev: ProductFormState, form: FormData): Promise<ProductFormState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageSavings(user.roles)) return { errors: { form: "forbidden" }, attempt };
  const field = (k: string) => String(form.get(k) ?? "");

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      createProduct(
        ctx,
        {
          code: field("code"),
          nameEn: field("nameEn"),
          nameBn: field("nameBn"),
          frequency: field("frequency"),
          installment: field("installment"),
          minDeposit: field("minDeposit"),
        },
        { userId: user.userId, device },
      ),
    );
  } catch (err) {
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  redirect(`/savings?created=${result.id}`);
}
