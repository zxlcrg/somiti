"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import {
  approveExit,
  cancelExit,
  canManageMembers,
  rejectExit,
  requestExit,
  type ExitDecisionError,
  type ExitRequestError,
} from "@/modules/members";
import { getCurrentUser } from "../../../auth";

/** Ledger refusals an officer can understand and act on. */
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD"]);

type FormError = "forbidden" | "server" | LedgerErrorCode;

async function officer() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
  return { user, device, allowed: canManageMembers(user.roles) };
}

export interface ExitRequestState {
  errors?: Partial<Record<"reason" | "method" | "paymentRef", ExitRequestError>> & { form?: ExitRequestError | FormError };
  attempt?: number;
}

export async function requestExitAction(memberId: string, prev: ExitRequestState, form: FormData): Promise<ExitRequestState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const { user, device, allowed } = await officer();
  if (!allowed) return { errors: { form: "forbidden" }, attempt };
  let result;
  try {
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      requestExit(
        ctx,
        {
          memberId,
          reason: String(form.get("reason") ?? ""),
          method: String(form.get("method") ?? ""),
          paymentRef: String(form.get("paymentRef") ?? ""),
          submitKey: String(form.get("submitKey") ?? ""),
        },
        { userId: user.userId, device },
      ),
    );
  } catch (err) {
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  revalidatePath(`/members/${memberId}`);
  redirect(`/members/${memberId}?exit=requested#exit-title`);
}

export interface ExitDecisionState {
  error?: ExitDecisionError | FormError;
  attempt?: number;
}

async function decide(
  memberId: string,
  prev: ExitDecisionState,
  outcome: "approved" | "rejected" | "cancelled",
  run: (ctx: Parameters<Parameters<typeof withTenant>[2]>[0], userId: string, device?: string) => Promise<{ ok: true } | { ok: false; error: ExitDecisionError }>,
): Promise<ExitDecisionState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const { user, device, allowed } = await officer();
  if (!allowed) return { error: "forbidden", attempt };
  let result;
  try {
    result = await withTenant(getAppDb(), user.tenantId, (ctx) => run(ctx, user.userId, device));
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { error: err.code, attempt };
    console.error(err);
    return { error: "server", attempt };
  }
  if (!result.ok) return { error: result.error, attempt };
  revalidatePath(`/members/${memberId}`);
  revalidatePath("/members");
  redirect(`/members/${memberId}?exit=${outcome}#exit-title`);
}

export async function approveExitAction(memberId: string, exitId: string, prev: ExitDecisionState): Promise<ExitDecisionState> {
  return decide(memberId, prev, "approved", (ctx, userId, device) => approveExit(ctx, { exitId, userId, device }));
}

export async function rejectExitAction(memberId: string, exitId: string, prev: ExitDecisionState, form: FormData): Promise<ExitDecisionState> {
  const note = String(form.get("note") ?? "");
  return decide(memberId, prev, "rejected", (ctx, userId, device) => rejectExit(ctx, { exitId, userId, device, note }));
}

export async function cancelExitAction(memberId: string, exitId: string, prev: ExitDecisionState): Promise<ExitDecisionState> {
  return decide(memberId, prev, "cancelled", (ctx, userId, device) => cancelExit(ctx, { exitId, userId, device }));
}
