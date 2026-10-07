"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { canCloseDay, closeDay, DENOMINATIONS, type CloseDayError } from "@/modules/dayend";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import { getCurrentUser } from "../auth";

const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD"]);

export interface CloseDayState {
  errors?: Partial<Record<"pieces" | "other" | "note", CloseDayError>> & { form?: CloseDayError | "forbidden" | "server" | LedgerErrorCode };
  attempt?: number;
}

export async function closeDayAction(date: string, prev: CloseDayState, form: FormData): Promise<CloseDayState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canCloseDay(user.roles)) return { errors: { form: "forbidden" }, attempt };
  const pieces = Object.fromEntries(DENOMINATIONS.map((d) => [String(d), String(form.get(`n${d}`) ?? "")]));

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      closeDay(ctx, { date, pieces, other: String(form.get("other") ?? ""), note: String(form.get("note") ?? "") }, { userId: user.userId, device }),
    );
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { errors: { form: err.code }, attempt };
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  revalidatePath("/", "layout");
  redirect(`/day-end?closed=${result.closeId}`);
}
