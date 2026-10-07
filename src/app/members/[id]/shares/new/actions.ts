"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import { buyShares, canRecordPayments, type BuySharesError } from "@/modules/members";
import { getCurrentUser } from "../../../../auth";

/** Ledger refusals the cashier can understand and act on. */
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD", "AFTER_BUSINESS_DATE", "IDEMPOTENCY_CONFLICT"]);

export interface BuySharesState {
  errors?: Partial<Record<"shares" | "method" | "paymentRef", BuySharesError>> & {
    form?: BuySharesError | "forbidden" | "server" | LedgerErrorCode;
  };
  attempt?: number;
}

export async function buySharesAction(memberId: string, prev: BuySharesState, form: FormData): Promise<BuySharesState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canRecordPayments(user.roles)) return { errors: { form: "forbidden" }, attempt };

  const input = {
    memberId,
    shares: String(form.get("shares") ?? ""),
    method: String(form.get("method") ?? ""),
    paymentRef: String(form.get("paymentRef") ?? ""),
    idempotencyKey: String(form.get("idempotencyKey") ?? ""),
  };
  if (input.idempotencyKey.length < 8) return { errors: { form: "server" }, attempt };

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) => buyShares(ctx, input, { userId: user.userId, device }));
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { errors: { form: err.code }, attempt };
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  redirect(`/members/${memberId}?bought=${result.purchase.id}#shares-title`);
}
