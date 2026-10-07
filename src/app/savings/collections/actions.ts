"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import { canReceiveHandovers, receiveHandover, type HandoverError } from "@/modules/savings";
import { getCurrentUser } from "../../auth";

/** Ledger refusals the cashier can understand and act on. */
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD", "IDEMPOTENCY_CONFLICT"]);

export interface HandoverState {
  errors?: Partial<Record<"amount" | "note", HandoverError>> & { form?: HandoverError | "forbidden" | "server" | LedgerErrorCode };
  /** Paisa as a string, when the count was over what the collector holds. */
  held?: string;
  attempt?: number;
}

export async function receiveHandoverAction(collectorId: string, prev: HandoverState, form: FormData): Promise<HandoverState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canReceiveHandovers(user.roles)) return { errors: { form: "forbidden" }, attempt };
  const idempotencyKey = String(form.get("idempotencyKey") ?? "");
  if (idempotencyKey.length < 8) return { errors: { form: "server" }, attempt };

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      receiveHandover(
        ctx,
        { collectorId, amount: String(form.get("amount") ?? ""), note: String(form.get("note") ?? ""), idempotencyKey },
        { userId: user.userId, device },
      ),
    );
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { errors: { form: err.code }, attempt };
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, held: result.held?.toString(), attempt };
  redirect(`/savings/collections?received=${result.handoverId}`);
}
