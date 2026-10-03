"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { admitMember, canManageMembers, type AdmitMemberInput, type MemberFieldErrors } from "@/modules/members";
import { getCurrentUser } from "../../auth";

export interface AdmitState {
  errors?: MemberFieldErrors & { form?: "server" | "forbidden" };
  /** What was typed, so a failed submit keeps the form filled in. */
  values?: Record<string, string>;
}

const FIELDS = [
  "nameEn",
  "nameBn",
  "guardianRelation",
  "guardianNameEn",
  "guardianNameBn",
  "phone",
  "nid",
  "dateOfBirth",
  "address",
  "commLocale",
  "admissionDate",
] as const;

export async function admitAction(_prev: AdmitState, form: FormData): Promise<AdmitState> {
  const values: Record<string, string> = {};
  for (const f of FIELDS) values[f] = String(form.get(f) ?? "");

  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canManageMembers(user.roles)) return { values, errors: { form: "forbidden" } };

  const input: AdmitMemberInput = {
    nameEn: values.nameEn,
    nameBn: values.nameBn,
    guardianRelation: values.guardianRelation === "husband" ? "husband" : "father",
    guardianNameEn: values.guardianNameEn,
    guardianNameBn: values.guardianNameBn,
    phone: values.phone ?? "",
    nid: values.nid,
    dateOfBirth: values.dateOfBirth,
    address: values.address,
    commLocale: values.commLocale === "en" || values.commLocale === "bn" ? values.commLocale : undefined,
    admissionDate: values.admissionDate,
  };
  // The relation only matters when a guardian name was typed.
  if (!values.guardianNameEn?.trim() && !values.guardianNameBn?.trim()) delete input.guardianRelation;

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) => admitMember(ctx, input, { userId: user.userId, device }));
  } catch (err) {
    console.error(err);
    return { values, errors: { form: "server" } };
  }
  if (!result.ok) return { values, errors: result.errors };
  redirect(`/members/${result.member.id}?admitted=1`);
}
