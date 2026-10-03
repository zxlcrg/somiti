import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, member, nominee } from "../src/db/schema";
import { toBanglaDigits } from "../src/lib/digits";
import {
  admitMember,
  equalShares,
  listNominees,
  parseSharePercent,
  saveNominees,
  type NomineeInput,
} from "../src/modules/members";
import { openNid } from "../src/modules/members/nid";
import { newTenant, type TestTenant } from "./helpers";

const BUSINESS_DATE = "2026-10-03";

async function memberOf(t: TestTenant) {
  const r = await t.run((ctx) => admitMember(ctx, { nameEn: "Rahima", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!r.ok) throw new Error("admit failed");
  return r.member;
}

function save(t: TestTenant, memberId: string, inputs: NomineeInput[]) {
  return t.run((ctx) => saveNominees(ctx, memberId, inputs, { userId: t.adminUserId, device: "test" }));
}

const karim: NomineeInput = { nameEn: "Abdul Karim", relation: "spouse", share: "60" };
const salma: NomineeInput = { nameBn: "সালমা", relation: "daughter", share: "40", dateOfBirth: "1999-01-01" };

describe("share percentages", () => {
  it("parses whole and two-decimal percents, in either script", () => {
    expect(parseSharePercent("50")).toBe(5000);
    expect(parseSharePercent("33.33")).toBe(3333);
    expect(parseSharePercent("12.5 %")).toBe(1250);
    expect(parseSharePercent(toBanglaDigits("25"))).toBe(2500);
    expect(parseSharePercent("100")).toBe(10000);
    for (const bad of ["", "0", "100.01", "101", "1.234", "-5", "abc"]) expect(parseSharePercent(bad)).toBeNull();
  });

  it("splits 100% evenly, to the last basis point", () => {
    expect(equalShares(3)).toEqual([3334, 3333, 3333]);
    expect(equalShares(4)).toEqual([2500, 2500, 2500, 2500]);
    expect(equalShares(3).reduce((a, b) => a + b)).toBe(10000);
  });
});

describe("saving nominees", () => {
  it("saves a set whose shares total 100% and lists it, largest share first", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    const result = await save(t, m.id, [salma, karim]);
    expect(result).toMatchObject({ ok: true, changed: true });
    const list = await t.run((ctx) => listNominees(ctx, m.id));
    expect(list.map((n) => [n.nameEn ?? n.nameBn, n.relation, n.shareBp])).toEqual([
      ["Abdul Karim", "spouse", 6000],
      ["সালমা", "daughter", 4000],
    ]);
  });

  it("refuses shares that don't add up to 100%", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    expect(await save(t, m.id, [karim, { ...salma, share: "30" }])).toEqual({
      ok: false,
      rows: {},
      form: "shares_total",
      totalBp: 9000,
    });
  });

  it("reports every problem, row by row", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    const result = await save(t, m.id, [
      { relation: "cousin", share: "0", phone: "123", nid: "12" },
      { nameEn: "Tiny", relation: "son", share: "100", dateOfBirth: "2020-05-05" },
      { nameEn: "Later", relation: "son", share: "1", dateOfBirth: "2027-01-01" },
    ]);
    expect(result).toEqual({
      ok: false,
      rows: {
        0: { nameEn: "name_required", relation: "invalid_relation", phone: "invalid_phone", nid: "invalid_nid", share: "invalid_share" },
        1: { minorGuardianNameEn: "guardian_required" },
        2: { dateOfBirth: "future_date" },
      },
    });
  });

  it("takes a guardian for a minor, and drops a guardian given for an adult", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await save(t, m.id, [
      { nameEn: "Tiny", relation: "son", share: "50", dateOfBirth: "2020-05-05", minorGuardianNameBn: "রহিমা" },
      { ...karim, share: "50", minorGuardianNameEn: "Nobody" },
    ]);
    const list = await t.run((ctx) => listNominees(ctx, m.id));
    expect(list.find((n) => n.nameEn === "Tiny")?.minorGuardianNameBn).toBe("রহিমা");
    expect(list.find((n) => n.nameEn === "Abdul Karim")?.minorGuardianNameEn).toBeNull();
  });

  it("keeps the old set as history, and keeps a nominee's NID when the row is carried over", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await save(t, m.id, [{ ...karim, share: "100", nid: toBanglaDigits("1234567890") }]);
    const [first] = await t.run((ctx) => listNominees(ctx, m.id));
    expect(first!.nidLast4).toBe("7890");

    await save(t, m.id, [{ ...karim, id: first!.id, share: "60" }, salma]);
    const all = await t.run(({ tx }) => tx.select().from(nominee).where(sql`${nominee.memberId} = ${m.id}`));
    expect(all).toHaveLength(3);
    expect(all.filter((n) => n.removedAt).map((n) => n.shareBp)).toEqual([10000]);
    const carried = all.find((n) => !n.removedAt && n.nameEn === "Abdul Karim")!;
    expect(openNid(carried.nidCipher!)).toBe("1234567890");

    const audit = await t.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} = 'member.nominees'`));
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("1234567890");
  });

  it("does nothing when the same set is saved again, and can clear all nominees", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await save(t, m.id, [karim, salma]);
    expect(await save(t, m.id, [salma, karim])).toMatchObject({ ok: true, changed: false });
    expect(await save(t, m.id, [])).toMatchObject({ ok: true, changed: true, nominees: [] });
  });

  it("only changes nominees of an active member", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await t.run(({ tx }) => tx.update(member).set({ status: "deceased" }).where(sql`${member.id} = ${m.id}`));
    expect(await save(t, m.id, [{ ...karim, share: "100" }])).toEqual({ ok: false, rows: {}, form: "member_inactive" });
    expect(await save(t, "00000000-0000-4000-8000-000000000000", [])).toEqual({ ok: false, rows: {}, form: "not_found" });
  });
});

describe("the database itself", () => {
  const sm = (code: string) => ({ cause: expect.objectContaining({ code }) });

  it("refuses active shares that don't total 100%, at commit", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await expect(
      t.run(({ tx, tenantId }) =>
        tx.insert(nominee).values({ tenantId, memberId: m.id, nameEn: "Half", relation: "son", shareBp: 5000, createdBy: t.adminUserId }),
      ),
    ).rejects.toMatchObject(sm("SM008"));
  });

  it("won't let a removed nominee change or come back, nor the app edit or delete one", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await memberOf(t);
    await save(t, m.id, [{ ...karim, share: "100" }]);
    await save(t, m.id, []);
    const [removed] = await t.run(({ tx }) => tx.select().from(nominee).where(sql`${nominee.memberId} = ${m.id}`));
    await expect(
      t.run(({ tx }) => tx.update(nominee).set({ removedAt: null, removedBy: null }).where(sql`${nominee.id} = ${removed!.id}`)),
    ).rejects.toMatchObject(sm("SM009"));
    await expect(t.run(({ tx }) => tx.execute(sql`update nominee set share_bp = 1 where id = ${removed!.id}`))).rejects.toMatchObject(
      sm("42501"),
    );
    await expect(t.run(({ tx }) => tx.execute(sql`delete from nominee where id = ${removed!.id}`))).rejects.toMatchObject(sm("42501"));
  });

  it("keeps each somiti's nominees to itself", async () => {
    const a = await newTenant(BUSINESS_DATE);
    const b = await newTenant(BUSINESS_DATE);
    const m = await memberOf(a);
    await save(a, m.id, [{ ...karim, share: "100" }]);
    expect(await b.run((ctx) => listNominees(ctx, m.id))).toEqual([]);
  });
});
