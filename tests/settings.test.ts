import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema";
import { readSession } from "../src/modules/auth";
import {
  addStaff,
  canManageSettings,
  getSomitiSettings,
  listStaff,
  setStaffActive,
  updateSomitiSettings,
  updateStaff,
} from "../src/modules/tenancy";
import { toBanglaDigits } from "../src/lib/digits";
import { app, newTenant, type TestTenant } from "./helpers";

const actor = (t: TestTenant) => ({ userId: t.adminUserId, device: "test" });

describe("somiti settings", () => {
  it("is the admin's job", () => {
    expect(canManageSettings(["admin"])).toBe(true);
    expect(canManageSettings(["president", "secretary", "cashier", "field_collector"])).toBe(false);
  });

  it("saves names, default language and share price, and audits the change", async () => {
    const t = await newTenant();
    const r = await t.run((ctx) =>
      updateSomitiSettings(ctx, { nameEn: "Savar Somiti", nameBn: "সাভার সমিতি", defaultLocale: "bn", sharePrice: toBanglaDigits("250") }, actor(t)),
    );
    expect(r).toEqual({ ok: true, changed: true });
    expect(await t.run((ctx) => getSomitiSettings(ctx))).toMatchObject({
      nameEn: "Savar Somiti",
      nameBn: "সাভার সমিতি",
      defaultLocale: "bn",
      sharePrice: 250_00n,
    });
    const again = await t.run((ctx) =>
      updateSomitiSettings(ctx, { nameEn: "Savar Somiti", nameBn: "সাভার সমিতি", defaultLocale: "bn", sharePrice: "250" }, actor(t)),
    );
    expect(again).toEqual({ ok: true, changed: false });
    const audit = await t.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} = 'settings.somiti.update'`));
    expect(audit).toHaveLength(1);
  });

  it("explains what's wrong", async () => {
    const t = await newTenant();
    expect(await t.run((ctx) => updateSomitiSettings(ctx, { defaultLocale: "fr", sharePrice: "0" }, actor(t)))).toEqual({
      ok: false,
      errors: { nameEn: "name_required", defaultLocale: "invalid_locale", sharePrice: "invalid_price" },
    });
    expect(await t.run((ctx) => updateSomitiSettings(ctx, { nameEn: "X", defaultLocale: "en", sharePrice: "200000" }, actor(t)))).toEqual({
      ok: false,
      errors: { sharePrice: "price_too_high" },
    });
  });
});

describe("staff", () => {
  it("adds people with their roles, and refuses a phone number already in use", async () => {
    const t = await newTenant();
    const r = await t.run((ctx) =>
      addStaff(ctx, { nameEn: "Nasima", phone: "01811-222333", roles: ["cashier", "secretary", "cashier"] }, actor(t)),
    );
    expect(r).toMatchObject({ ok: true, changed: true });
    const staff = await t.run((ctx) => listStaff(ctx));
    expect(staff.find((s) => s.nameEn === "Nasima")).toMatchObject({ phone: "+8801811222333", isActive: true, roles: ["secretary", "cashier"] });
    expect(await t.run((ctx) => addStaff(ctx, { nameBn: "অন্য", phone: "01811222333", roles: ["cashier"] }, actor(t)))).toEqual({
      ok: false,
      errors: { phone: "duplicate_phone" },
    });
  });

  it("checks the form", async () => {
    const t = await newTenant();
    expect(await t.run((ctx) => addStaff(ctx, { phone: "123", roles: [] }, actor(t)))).toEqual({
      ok: false,
      errors: { nameEn: "name_required", phone: "invalid_phone", roles: "role_required" },
    });
    expect(await t.run((ctx) => addStaff(ctx, { nameEn: "X", phone: "01811222333", roles: ["member"] }, actor(t)))).toEqual({
      ok: false,
      errors: { roles: "invalid_role" },
    });
  });

  it("changes roles and details, keeping the audit trail", async () => {
    const t = await newTenant();
    const added = await t.run((ctx) => addStaff(ctx, { nameEn: "Rafiq", phone: "01911222333", roles: ["field_collector"] }, actor(t)));
    if (!added.ok) throw new Error("add failed");
    const r = await t.run((ctx) =>
      updateStaff(ctx, added.userId, { nameEn: "Rafiqul", phone: "01911222333", roles: ["cashier", "field_collector"] }, actor(t)),
    );
    expect(r).toMatchObject({ ok: true, changed: true });
    expect((await t.run((ctx) => listStaff(ctx))).find((s) => s.id === added.userId)).toMatchObject({
      nameEn: "Rafiqul",
      roles: ["cashier", "field_collector"],
    });
    const audit = await t.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} like 'settings.staff.%'`));
    expect(audit.map((a) => a.action).sort()).toEqual(["settings.staff.add", "settings.staff.update"]);
  });

  it("never lets a somiti lock itself out", async () => {
    const t = await newTenant();
    // Test admins get random phone numbers; use a valid one so only the rule under test can fail.
    const me = { ...(await t.run((ctx) => listStaff(ctx)))[0]!, phone: "01700000999" };
    // Your own admin role and your own access stay.
    expect(await t.run((ctx) => updateStaff(ctx, me.id, { nameEn: "Admin", phone: me.phone, roles: ["cashier"] }, actor(t)))).toEqual({
      ok: false,
      errors: { roles: "own_admin" },
    });
    expect(await t.run((ctx) => setStaffActive(ctx, me.id, false, actor(t)))).toEqual({ ok: false, errors: { form: "self_deactivate" } });

    // Another admin can't remove the last admin either.
    const second = await t.run((ctx) => addStaff(ctx, { nameEn: "President", phone: "01711000111", roles: ["president"] }, actor(t)));
    if (!second.ok) throw new Error("add failed");
    const bySecond = { userId: second.userId };
    expect(await t.run((ctx) => updateStaff(ctx, me.id, { nameEn: "Admin", phone: me.phone, roles: ["cashier"] }, bySecond))).toEqual({
      ok: false,
      errors: { roles: "last_admin" },
    });
    expect(await t.run((ctx) => setStaffActive(ctx, me.id, false, bySecond))).toEqual({ ok: false, errors: { form: "last_admin" } });

    // With a second admin, the first can step down.
    await t.run((ctx) => updateStaff(ctx, second.userId, { nameEn: "President", phone: "01711000111", roles: ["president", "admin"] }, actor(t)));
    expect(await t.run((ctx) => setStaffActive(ctx, me.id, false, bySecond))).toMatchObject({ ok: true, changed: true });
  });

  it("ends a deactivated person's sessions at once, and can bring them back", async () => {
    const t = await newTenant();
    const added = await t.run((ctx) => addStaff(ctx, { nameEn: "Collector", phone: "01611222333", roles: ["field_collector"] }, actor(t)));
    if (!added.ok) throw new Error("add failed");
    const token = "x".repeat(43);
    await app.pool.query("select 1");
    await t.run(({ tx, tenantId }) =>
      tx.execute(
        sql`insert into user_session (tenant_id, user_id, token_hash, expires_at) values (${tenantId}, ${added.userId}, encode(sha256(${token}::bytea), 'hex'), now() + interval '1 day')`,
      ),
    );
    const cookie = `${t.tenantId}.${token}`;
    expect(await readSession(app.db, cookie)).not.toBeNull();
    await t.run((ctx) => setStaffActive(ctx, added.userId, false, actor(t)));
    expect(await readSession(app.db, cookie)).toBeNull();
    await t.run((ctx) => setStaffActive(ctx, added.userId, true, actor(t)));
    expect(await readSession(app.db, cookie)).not.toBeNull();
  });
});
