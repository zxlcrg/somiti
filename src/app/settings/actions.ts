"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import {
  addStaff,
  canManageSettings,
  setStaffActive,
  updateSomitiSettings,
  updateStaff,
  type SomitiErrors,
  type StaffErrors,
} from "@/modules/tenancy";
import { getCurrentUser } from "../auth";

type FormProblem = "forbidden" | "server";

export interface SomitiState {
  errors?: SomitiErrors & { form?: FormProblem };
  notice?: "saved" | "unchanged";
  /** Bumped on every submit so the same message shows again. */
  attempt?: number;
}

export interface StaffState {
  errors?: Omit<StaffErrors, "form"> & { form?: StaffErrors["form"] | FormProblem };
  /** What happened, for the toast: who and how. */
  done?: { kind: "added" | "updated" | "deactivated" | "reactivated"; userId: string };
  attempt?: number;
}

async function admin() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
  return { user, device, allowed: canManageSettings(user.roles) };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function saveSomitiAction(prev: SomitiState, form: FormData): Promise<SomitiState> {
  const { user, device, allowed } = await admin();
  const attempt = (prev.attempt ?? 0) + 1;
  if (!allowed) return { errors: { form: "forbidden" }, attempt };
  try {
    const r = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      updateSomitiSettings(
        ctx,
        { nameEn: text(form, "nameEn"), nameBn: text(form, "nameBn"), defaultLocale: text(form, "defaultLocale"), sharePrice: text(form, "sharePrice") },
        { userId: user.userId, device },
      ),
    );
    if (!r.ok) return { errors: r.errors, attempt };
    revalidatePath("/", "layout");
    return { notice: r.changed ? "saved" : "unchanged", attempt };
  } catch (e) {
    console.error("saveSomitiAction", e);
    return { errors: { form: "server" }, attempt };
  }
}

/** Adds someone (no id) or changes them (with id). */
export async function saveStaffAction(prev: StaffState, form: FormData): Promise<StaffState> {
  const { user, device, allowed } = await admin();
  const attempt = (prev.attempt ?? 0) + 1;
  if (!allowed) return { errors: { form: "forbidden" }, attempt };
  const id = text(form, "id");
  const fields = { nameEn: text(form, "nameEn"), nameBn: text(form, "nameBn"), phone: text(form, "phone"), roles: form.getAll("roles").map(String) };
  try {
    const r = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      id ? updateStaff(ctx, id, fields, { userId: user.userId, device }) : addStaff(ctx, fields, { userId: user.userId, device }),
    );
    if (!r.ok) return { errors: r.errors, attempt };
    revalidatePath("/", "layout");
    return { done: { kind: id ? "updated" : "added", userId: r.userId }, attempt };
  } catch (e) {
    console.error("saveStaffAction", e);
    return { errors: { form: "server" }, attempt };
  }
}

export async function setStaffActiveAction(prev: StaffState, form: FormData): Promise<StaffState> {
  const { user, device, allowed } = await admin();
  const attempt = (prev.attempt ?? 0) + 1;
  if (!allowed) return { errors: { form: "forbidden" }, attempt };
  const id = text(form, "id");
  const active = text(form, "active") === "true";
  try {
    const r = await withTenant(getAppDb(), user.tenantId, (ctx) => setStaffActive(ctx, id, active, { userId: user.userId, device }));
    if (!r.ok) return { errors: r.errors, attempt };
    revalidatePath("/", "layout");
    return { done: { kind: active ? "reactivated" : "deactivated", userId: id }, attempt };
  } catch (e) {
    console.error("setStaffActiveAction", e);
    return { errors: { form: "server" }, attempt };
  }
}
