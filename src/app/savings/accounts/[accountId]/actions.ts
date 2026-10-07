"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import { deposit, depositChannel, type DepositError } from "@/modules/savings";
import { getCurrentUser } from "../../../auth";

/** Ledger refusals the cashier can understand and act on. */
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD", "AFTER_BUSINESS_DATE", "IDEMPOTENCY_CONFLICT"]);

export interface DepositState {
  errors?: Partial<Record<"amount" | "method" | "paymentRef", DepositError>> & {
    form?: DepositError | "forbidden" | "server" | LedgerErrorCode;
  };
  attempt?: number;
}

export async function depositAction(accountId: string, prev: DepositState, form: FormData): Promise<DepositState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const channel = depositChannel(user.roles);
  if (!channel) return { errors: { form: "forbidden" }, attempt };

  const input = {
    accountId,
    amount: String(form.get("amount") ?? ""),
    method: String(form.get("method") ?? ""),
    paymentRef: String(form.get("paymentRef") ?? ""),
    idempotencyKey: String(form.get("idempotencyKey") ?? ""),
  };
  if (input.idempotencyKey.length < 8) return { errors: { form: "server" }, attempt };

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) => deposit(ctx, input, { userId: user.userId, channel, device }));
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { errors: { form: err.code }, attempt };
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  redirect(`/savings/accounts/${accountId}?deposited=${result.deposit.id}`);
}
