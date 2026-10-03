"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getAppDb, withTenant } from "@/db/client";
import { canManageMembers, MAX_PHOTO_BYTES, removeMemberPhoto, setMemberPhoto } from "@/modules/members";
import { getCurrentUser } from "../../../auth";

export type PhotoActionResult =
  | { ok: true; version: string | null }
  | { ok: false; error: "empty" | "too_large" | "not_image" | "not_found" | "forbidden" | "server" };

async function actor() {
  const user = await getCurrentUser();
  if (!user || !canManageMembers(user.roles)) return null;
  const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
  return { user, device };
}

export async function uploadPhotoAction(memberId: string, form: FormData): Promise<PhotoActionResult> {
  const who = await actor();
  if (!who) return { ok: false, error: "forbidden" };
  const file = form.get("photo");
  if (!(file instanceof File)) return { ok: false, error: "empty" };
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, error: "too_large" };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await withTenant(getAppDb(), who.user.tenantId, (ctx) =>
      setMemberPhoto(ctx, memberId, bytes, { userId: who.user.userId, device: who.device }),
    );
    if (!result.ok) return result;
    revalidatePath(`/members/${memberId}`);
    revalidatePath("/members");
    return { ok: true, version: result.version };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "server" };
  }
}

export async function removePhotoAction(memberId: string): Promise<PhotoActionResult> {
  const who = await actor();
  if (!who) return { ok: false, error: "forbidden" };
  try {
    const result = await withTenant(getAppDb(), who.user.tenantId, (ctx) =>
      removeMemberPhoto(ctx, memberId, { userId: who.user.userId, device: who.device }),
    );
    if (!result.ok) return { ok: false, error: "not_found" };
    revalidatePath(`/members/${memberId}`);
    revalidatePath("/members");
    return { ok: true, version: null };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "server" };
  }
}
