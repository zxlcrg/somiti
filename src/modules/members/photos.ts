import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { member, memberPhoto } from "@/db/schema";
import { recordAudit } from "@/modules/audit/log";

/** Matches the member_photo_size check. The browser sends about 50 KB. */
export const MAX_PHOTO_BYTES = 512_000;

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";

/**
 * The image type from the file's own first bytes. What the browser claims
 * is ignored, so a renamed script can't be stored or served as a photo.
 */
export function detectImageType(bytes: Uint8Array): PhotoType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export type SetPhotoResult =
  | { ok: true; version: string; changed: boolean }
  | { ok: false; error: "empty" | "too_large" | "not_image" | "not_found" };

/** How photo URLs are versioned: the start of the SHA-256, so a new photo gets a new URL. */
export function photoVersion(sha256: string): string {
  return sha256.slice(0, 16);
}

async function lockMember({ tx, tenantId }: TenantTx, memberId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.tenantId, tenantId), eq(member.id, memberId)))
    .for("update");
  return !!row;
}

async function currentPhoto({ tx, tenantId }: TenantTx, memberId: string) {
  const [row] = await tx
    .select({ id: memberPhoto.id, sha256: memberPhoto.sha256, byteSize: memberPhoto.byteSize })
    .from(memberPhoto)
    .where(and(eq(memberPhoto.tenantId, tenantId), eq(memberPhoto.memberId, memberId), isNull(memberPhoto.removedAt)));
  return row;
}

/** Sets a member's photo, keeping the previous one on record. The same image again changes nothing. */
export async function setMemberPhoto(
  ctx: TenantTx,
  memberId: string,
  bytes: Uint8Array,
  actor: { userId: string; device?: string },
): Promise<SetPhotoResult> {
  if (bytes.length === 0) return { ok: false, error: "empty" };
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: "too_large" };
  const contentType = detectImageType(bytes);
  if (!contentType) return { ok: false, error: "not_image" };
  if (!(await lockMember(ctx, memberId))) return { ok: false, error: "not_found" };

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const previous = await currentPhoto(ctx, memberId);
  if (previous?.sha256 === sha256) return { ok: true, version: photoVersion(sha256), changed: false };

  const { tx, tenantId } = ctx;
  if (previous) {
    await tx
      .update(memberPhoto)
      .set({ removedAt: sql`now()`, removedBy: actor.userId })
      .where(eq(memberPhoto.id, previous.id));
  }
  await tx.insert(memberPhoto).values({
    tenantId,
    memberId,
    contentType,
    bytes: Buffer.from(bytes),
    byteSize: bytes.length,
    sha256,
    createdBy: actor.userId,
  });
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: previous ? "member.photo.replace" : "member.photo.add",
    entityType: "member",
    entityId: memberId,
    before: previous ? { sha256: previous.sha256, byteSize: previous.byteSize } : undefined,
    after: { sha256, byteSize: bytes.length, contentType },
    device: actor.device,
  });
  return { ok: true, version: photoVersion(sha256), changed: true };
}

/** Takes the photo off the member's record; it stays in the history. */
export async function removeMemberPhoto(
  ctx: TenantTx,
  memberId: string,
  actor: { userId: string; device?: string },
): Promise<{ ok: boolean; changed: boolean }> {
  if (!(await lockMember(ctx, memberId))) return { ok: false, changed: false };
  const previous = await currentPhoto(ctx, memberId);
  if (!previous) return { ok: true, changed: false };
  await ctx.tx
    .update(memberPhoto)
    .set({ removedAt: sql`now()`, removedBy: actor.userId })
    .where(eq(memberPhoto.id, previous.id));
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "member.photo.remove",
    entityType: "member",
    entityId: memberId,
    before: { sha256: previous.sha256, byteSize: previous.byteSize },
    device: actor.device,
  });
  return { ok: true, changed: true };
}

/** The current photo's bytes, for the image endpoint. */
export async function getMemberPhoto(
  { tx, tenantId }: TenantTx,
  memberId: string,
): Promise<{ contentType: string; bytes: Buffer; sha256: string } | null> {
  const [row] = await tx
    .select({ contentType: memberPhoto.contentType, bytes: memberPhoto.bytes, sha256: memberPhoto.sha256 })
    .from(memberPhoto)
    .where(and(eq(memberPhoto.tenantId, tenantId), eq(memberPhoto.memberId, memberId), isNull(memberPhoto.removedAt)));
  return row ?? null;
}
