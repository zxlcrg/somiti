"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import {
  approveWithdrawal,
  canApproveWithdrawals,
  canRequestWithdrawals,
  cancelWithdrawal,
  rejectWithdrawal,
  requestWithdrawal,
  type DecisionError,
  type DecisionResult,
  type WithdrawalError,
} from "@/modules/savings";
import { getCurrentUser } from "../../auth";

/** Ledger refusals an officer can understand and act on. */
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD", "IDEMPOTENCY_CONFLICT"]);

const device = async () => (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;

export interface WithdrawState {
  errors?: Partial<Record<"amount" | "method" | "paymentRef" | "reason", WithdrawalError>> & {
    form?: WithdrawalError | "forbidden" | "server" | LedgerErrorCode;
  };
  /** Paisa as a string, when the amount was over what's available. */
  available?: string;
  attempt?: number;
}

export async function requestWithdrawalAction(accountId: string, prev: WithdrawState, form: FormData): Promise<WithdrawState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canRequestWithdrawals(user.roles)) return { errors: { form: "forbidden" }, attempt };
  const submitKey = String(form.get("submitKey") ?? "");
  if (submitKey.length < 8) return { errors: { form: "server" }, attempt };

  let result;
  try {
    const d = await device();
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      requestWithdrawal(
        ctx,
        {
          accountId,
          amount: String(form.get("amount") ?? ""),
          method: String(form.get("method") ?? ""),
          paymentRef: String(form.get("paymentRef") ?? ""),
          reason: String(form.get("reason") ?? ""),
          submitKey,
        },
        { userId: user.userId, device: d },
      ),
    );
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { errors: { form: err.code }, attempt };
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, available: result.available?.toString(), attempt };
  revalidatePath("/", "layout");
  redirect(`/savings/accounts/${accountId}?requested=${result.withdrawalId}&tab=withdraw`);
}

export interface DecideState {
  error?: DecisionError | "forbidden" | "server" | LedgerErrorCode;
  attempt?: number;
}

type Kind = "approve" | "reject" | "cancel";

/** Approve, reject or take back a request, then return to where it was decided. */
export async function decideWithdrawalAction(
  withdrawalId: string,
  returnTo: string,
  prev: DecideState,
  form: FormData,
): Promise<DecideState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const kind = String(form.get("kind")) as Kind;
  const note = String(form.get("note") ?? "");
  if (kind === "cancel" ? !canRequestWithdrawals(user.roles) : !canApproveWithdrawals(user.roles)) return { attempt, error: "forbidden" };

  let result: DecisionResult;
  try {
    const d = { withdrawalId, userId: user.userId, device: await device() };
    result = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
      if (kind === "approve") return approveWithdrawal(ctx, d);
      if (kind === "reject") return rejectWithdrawal(ctx, { ...d, note });
      if (kind === "cancel") return cancelWithdrawal(ctx, { ...d, note });
      return { ok: false, error: "not_found" } as const;
    });
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { attempt, error: err.code };
    console.error(err);
    return { attempt, error: "server" };
  }
  if (!result.ok) return { attempt, error: result.error };
  // The header counts withdrawals waiting for the viewer; refresh it along with the page.
  revalidatePath("/", "layout");
  const safe = returnTo.startsWith("/savings/") ? returnTo : "/savings/withdrawals";
  redirect(`${safe}${safe.includes("?") ? "&" : "?"}decided=${withdrawalId}&kind=${kind}`);
}
