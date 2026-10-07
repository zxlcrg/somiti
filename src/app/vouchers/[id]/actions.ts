"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import {
  approveVoucher,
  canApproveVouchers,
  cancelVoucher,
  LedgerError,
  rejectVoucher,
  type LedgerErrorCode,
} from "@/modules/ledger";
import { getCurrentUser } from "../../auth";

export interface DecisionState {
  error?: LedgerErrorCode | "forbidden" | "server" | "note_required";
  attempt?: number;
}

type Kind = "approve" | "reject" | "cancel";

export async function decideVoucherAction(voucherId: string, prev: DecisionState, form: FormData): Promise<DecisionState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const kind = String(form.get("kind")) as Kind;
  const note = String(form.get("note") ?? "");
  if ((kind === "approve" || kind === "reject") && !canApproveVouchers(user.roles)) return { attempt, error: "forbidden" };
  if (kind === "reject" && !note.trim()) return { attempt, error: "note_required" };

  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    const d = { voucherId, userId: user.userId, device };
    await withTenant(getAppDb(), user.tenantId, async (ctx) => {
      if (kind === "approve") await approveVoucher(ctx, d);
      else if (kind === "reject") await rejectVoucher(ctx, { ...d, note });
      else if (kind === "cancel") await cancelVoucher(ctx, { ...d, note });
      else throw new LedgerError("INVALID_INPUT", "Unknown decision");
    });
  } catch (err) {
    if (err instanceof LedgerError) return { attempt, error: err.code };
    console.error(err);
    return { attempt, error: "server" };
  }
  // The header counts vouchers waiting for the viewer; refresh it along with the page.
  revalidatePath("/", "layout");
  redirect(`/vouchers/${voucherId}?done=${kind}`);
}
