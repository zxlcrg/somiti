"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError } from "@/modules/ledger";
import { depositChannel } from "@/modules/savings";
import { recordSheet, type SheetEntry, type SheetLineError } from "@/modules/sheet";
import { getCurrentUser } from "../auth";
import { flushSms } from "../sms";

export interface SheetState {
  /** Per line, keyed "s:<account id>" or "l:<loan id>". */
  errors?: Record<string, SheetLineError>;
  form?: "empty" | "too_many" | "forbidden" | "DAY_CLOSED" | "NO_OPEN_PERIOD" | "server";
  attempt?: number;
}

/** Posts a filled-in sheet as cash taken by this officer; all lines or none. */
export async function recordSheetAction(prev: SheetState, form: FormData): Promise<SheetState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const channel = depositChannel(user.roles);
  if (!channel) return { form: "forbidden", attempt };
  const sheetKey = String(form.get("sheetKey") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(sheetKey)) return { form: "server", attempt };
  const entries: SheetEntry[] = [];
  for (const [name, value] of form.entries()) {
    const m = /^line:(s|l):([0-9a-f-]{36})$/i.exec(name);
    if (m) entries.push({ kind: m[1] === "s" ? "savings" : "loan", id: m[2]!, amount: String(value) });
  }
  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      recordSheet(ctx, entries, sheetKey, { userId: user.userId, channel, device }),
    );
  } catch (err) {
    if (err instanceof LedgerError && (err.code === "DAY_CLOSED" || err.code === "NO_OPEN_PERIOD")) return { form: err.code, attempt };
    console.error(err);
    return { form: "server", attempt };
  }
  if (!result.ok) return { errors: result.errors, form: result.form, attempt };
  await flushSms(user.tenantId);
  revalidatePath("/", "layout");
  redirect(`/collection-sheet?recorded=${result.count}&amount=${result.amount}&fines=${result.fines}`);
}
