"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import {
  approveCorrection,
  canApproveCorrections,
  canRequestCorrections,
  cancelCorrection,
  rejectCorrection,
  requestCorrection,
  type CorrectionError,
} from "@/modules/corrections";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import { getCurrentUser } from "../auth";

const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD"]);
const device = async () => (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export interface CorrectionState {
  error?: CorrectionError | "forbidden" | "server" | LedgerErrorCode;
  attempt?: number;
}

/** Asks for a correction, or approves, rejects or withdraws one. */
export async function correctionAction(
  step: "request" | "approve" | "reject" | "cancel",
  prev: CorrectionState,
  form: FormData,
): Promise<CorrectionState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const allowed = step === "approve" || step === "reject" ? canApproveCorrections(user.roles) : canRequestCorrections(user.roles);
  if (!allowed) return { error: "forbidden", attempt };
  const correctionId = field(form, "correctionId");
  let result;
  try {
    const actor = { userId: user.userId, device: await device() };
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      step === "request"
        ? requestCorrection(ctx, { entryId: field(form, "entryId"), reason: field(form, "reason"), submitKey: field(form, "submitKey") }, actor)
        : step === "approve"
          ? approveCorrection(ctx, { correctionId, note: field(form, "note"), ...actor })
          : step === "reject"
            ? rejectCorrection(ctx, { correctionId, note: field(form, "note"), ...actor })
            : cancelCorrection(ctx, { correctionId, ...actor }),
    );
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { error: err.code, attempt };
    console.error(err);
    return { error: "server", attempt };
  }
  if (!result.ok) return { error: result.error, attempt };
  revalidatePath("/", "layout");
  const id = "correctionId" in result ? result.correctionId : correctionId;
  redirect(`/corrections?done=${step}&id=${id}`);
}
