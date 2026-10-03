import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, memberPhoto } from "../src/db/schema";
import {
  admitMember,
  detectImageType,
  getMember,
  getMemberPhoto,
  listMembers,
  MAX_PHOTO_BYTES,
  removeMemberPhoto,
  setMemberPhoto,
} from "../src/modules/members";
import { newTenant, type TestTenant } from "./helpers";

/** Bytes that start like a JPEG; only the signature and size are checked. */
function fakeJpeg(fill: number, size = 2_000): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

async function memberOf(t: TestTenant) {
  const r = await t.run((ctx) => admitMember(ctx, { nameEn: "Photo Member", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!r.ok) throw new Error("admit failed");
  return r.member;
}

const actor = (t: TestTenant) => ({ userId: t.adminUserId, device: "test" });

describe("recognising images", () => {
  it("goes by the file's own bytes, not its name or claimed type", () => {
    expect(detectImageType(fakeJpeg(1))).toBe("image/jpeg");
    expect(detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(detectImageType(new TextEncoder().encode("<script>alert(1)</script>"))).toBeNull();
    expect(detectImageType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });
});

describe("member photos", () => {
  it("stores a photo, serves it back and shows its version on the member", async () => {
    const t = await newTenant();
    const m = await memberOf(t);
    expect(m.photoVersion).toBeNull();

    const result = await t.run((ctx) => setMemberPhoto(ctx, m.id, fakeJpeg(1), actor(t)));
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) return;
    expect(result.version).toHaveLength(16);

    const photo = await t.run((ctx) => getMemberPhoto(ctx, m.id));
    expect(photo?.contentType).toBe("image/jpeg");
    expect(Buffer.compare(photo!.bytes, Buffer.from(fakeJpeg(1)))).toBe(0);
    expect((await t.run((ctx) => getMember(ctx, m.id)))?.photoVersion).toBe(result.version);
    expect((await t.run((ctx) => listMembers(ctx))).members[0]?.photoVersion).toBe(result.version);
  });

  it("refuses empty, oversized and non-image files", async () => {
    const t = await newTenant();
    const m = await memberOf(t);
    const set = (bytes: Uint8Array) => t.run((ctx) => setMemberPhoto(ctx, m.id, bytes, actor(t)));
    expect(await set(new Uint8Array())).toEqual({ ok: false, error: "empty" });
    expect(await set(fakeJpeg(1, MAX_PHOTO_BYTES + 1))).toEqual({ ok: false, error: "too_large" });
    expect(await set(new TextEncoder().encode("not an image at all"))).toEqual({ ok: false, error: "not_image" });
    expect(
      await t.run((ctx) => setMemberPhoto(ctx, "00000000-0000-4000-8000-000000000000", fakeJpeg(1), actor(t))),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("keeps replaced and removed photos on record, with one current photo at a time", async () => {
    const t = await newTenant();
    const m = await memberOf(t);
    await t.run((ctx) => setMemberPhoto(ctx, m.id, fakeJpeg(1), actor(t)));
    expect(await t.run((ctx) => setMemberPhoto(ctx, m.id, fakeJpeg(1), actor(t)))).toMatchObject({ ok: true, changed: false });
    await t.run((ctx) => setMemberPhoto(ctx, m.id, fakeJpeg(2), actor(t)));

    let rows = await t.run(({ tx }) => tx.select().from(memberPhoto).where(sql`${memberPhoto.memberId} = ${m.id}`));
    expect(rows.filter((r) => !r.removedAt)).toHaveLength(1);
    expect(rows).toHaveLength(2);

    expect(await t.run((ctx) => removeMemberPhoto(ctx, m.id, actor(t)))).toEqual({ ok: true, changed: true });
    expect(await t.run((ctx) => removeMemberPhoto(ctx, m.id, actor(t)))).toEqual({ ok: true, changed: false });
    expect(await t.run((ctx) => getMemberPhoto(ctx, m.id))).toBeNull();
    rows = await t.run(({ tx }) => tx.select().from(memberPhoto).where(sql`${memberPhoto.memberId} = ${m.id}`));
    expect(rows.every((r) => r.removedAt)).toBe(true);

    const audit = await t.run(({ tx }) =>
      tx.select({ action: auditLog.action }).from(auditLog).where(sql`${auditLog.action} like 'member.photo.%'`),
    );
    expect(audit.map((a) => a.action).sort()).toEqual(["member.photo.add", "member.photo.remove", "member.photo.replace"]);
  });

  it("can't be edited, revived or deleted by the app, nor seen by another somiti", async () => {
    const t = await newTenant();
    const other = await newTenant();
    const m = await memberOf(t);
    await t.run((ctx) => setMemberPhoto(ctx, m.id, fakeJpeg(1), actor(t)));
    await t.run((ctx) => removeMemberPhoto(ctx, m.id, actor(t)));
    const [old] = await t.run(({ tx }) => tx.select().from(memberPhoto).where(sql`${memberPhoto.memberId} = ${m.id}`));
    const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });
    await expect(
      t.run(({ tx }) => tx.execute(sql`update member_photo set removed_at = null, removed_by = null where id = ${old!.id}`)),
    ).rejects.toMatchObject(code("SM009"));
    await expect(t.run(({ tx }) => tx.execute(sql`update member_photo set bytes = '\\x00' where id = ${old!.id}`))).rejects.toMatchObject(
      code("42501"),
    );
    await expect(t.run(({ tx }) => tx.execute(sql`delete from member_photo where id = ${old!.id}`))).rejects.toMatchObject(code("42501"));

    await t.run((ctx) => setMemberPhoto(ctx, m.id, fakeJpeg(3), actor(t)));
    expect(await other.run((ctx) => getMemberPhoto(ctx, m.id))).toBeNull();
  });
});
