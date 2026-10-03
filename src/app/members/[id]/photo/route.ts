import { getAppDb, withTenant } from "@/db/client";
import { canViewMembers, getMemberPhoto } from "@/modules/members";
import { getCurrentUser } from "../../../auth";

/**
 * Serves a member's current photo to signed-in staff of the same somiti.
 * URLs carry ?v=<version>; a matching version may be cached for good, since
 * a new photo gets a new version. The headers keep a browser from ever
 * treating the bytes as anything but an image.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!canViewMembers(user.roles)) return new Response(null, { status: 403 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response(null, { status: 404 });
  const photo = await withTenant(getAppDb(), user.tenantId, (ctx) => getMemberPhoto(ctx, id));
  if (!photo) return new Response(null, { status: 404 });

  const etag = `"${photo.sha256}"`;
  const requested = new URL(request.url).searchParams.get("v");
  const headers = {
    "Content-Type": photo.contentType,
    ETag: etag,
    "Cache-Control": requested && photo.sha256.startsWith(requested) ? "private, max-age=31536000, immutable" : "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(photo.bytes), { headers });
}
