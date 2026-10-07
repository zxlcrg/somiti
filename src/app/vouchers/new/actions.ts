"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import {
  branchForUser,
  canMakeVouchers,
  submitVoucher,
  type VoucherFormErrors,
  type VoucherLineForm,
} from "@/modules/ledger";
import { getCurrentUser } from "../../auth";

export interface VoucherFormState {
  errors?: VoucherFormErrors & { server?: "server" | "forbidden" };
  /** Changes on every failed submit, so the error message re-announces. */
  attempt?: number;
}

function readLines(raw: FormDataEntryValue | null): VoucherLineForm[] {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 100).map((l) => {
      const o = (l ?? {}) as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" ? v : "");
      return { accountId: s(o.accountId), debit: s(o.debit), credit: s(o.credit), memo: s(o.memo) };
    });
  } catch {
    return [];
  }
}

export async function submitVoucherAction(prev: VoucherFormState, form: FormData): Promise<VoucherFormState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canMakeVouchers(user.roles)) return { attempt, errors: { server: "forbidden" } };

  const submitKey = String(form.get("submitKey") ?? "").slice(0, 128) || undefined;
  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, async (ctx) =>
      submitVoucher(ctx, {
        narration: String(form.get("narration") ?? ""),
        lines: readLines(form.get("lines")),
        branchId: await branchForUser(ctx, user.userId),
        createdBy: user.userId,
        submitKey,
        device,
      }),
    );
  } catch (err) {
    console.error(err);
    return { attempt, errors: { server: "server" } };
  }
  if (!result.ok) return { attempt, errors: result.errors };
  revalidatePath("/", "layout");
  redirect(`/vouchers/${result.voucherId}?made=1`);
}
