"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { canManageMembers, saveNominees, type NomineeInput, type NomineeRowErrors } from "@/modules/members";
import { getCurrentUser } from "../../../auth";

export interface NomineesState {
  rows?: Record<number, NomineeRowErrors>;
  form?: "shares_total" | "too_many" | "member_inactive" | "not_found" | "server" | "forbidden";
  totalBp?: number;
  /** Bumps on every failed save, so the page can re-run its error animation. */
  attempt?: number;
}

const FIELDS = [
  "id",
  "nameEn",
  "nameBn",
  "relation",
  "phone",
  "nid",
  "dateOfBirth",
  "minorGuardianNameEn",
  "minorGuardianNameBn",
  "share",
] as const;

/** Keeps only known string fields from the posted rows. */
function parseRows(payload: FormDataEntryValue | null): NomineeInput[] | null {
  try {
    const raw: unknown = JSON.parse(String(payload ?? "[]"));
    if (!Array.isArray(raw)) return null;
    return raw.map((row) => {
      const clean: NomineeInput = {};
      for (const f of FIELDS) {
        const v = (row as Record<string, unknown>)?.[f];
        if (typeof v === "string") clean[f] = v;
      }
      return clean;
    });
  } catch {
    return null;
  }
}

export async function saveNomineesAction(memberId: string, prev: NomineesState, form: FormData): Promise<NomineesState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageMembers(user.roles)) return { form: "forbidden", attempt };

  const rows = parseRows(form.get("payload"));
  if (!rows) return { form: "server", attempt };

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      saveNominees(ctx, memberId, rows, { userId: user.userId, device }),
    );
  } catch (err) {
    console.error(err);
    return { form: "server", attempt };
  }
  if (!result.ok) return { rows: result.rows, form: result.form, totalBp: result.totalBp, attempt };
  redirect(`/members/${memberId}?nominees=${result.changed ? "saved" : "unchanged"}#nominees-title`);
}
