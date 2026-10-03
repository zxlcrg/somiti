import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, member } from "../src/db/schema";
import { toBanglaDigits } from "../src/lib/digits";
import { postEntry } from "../src/modules/ledger";
import { admitMember, canManageMembers, canViewMembers, getMember, listMembers, memberStats } from "../src/modules/members";
import { normalizeNid, openNid } from "../src/modules/members/nid";
import { deposit, newTenant, type TestTenant } from "./helpers";

const BUSINESS_DATE = "2026-10-03";

function admit(t: TestTenant, input: Parameters<typeof admitMember>[1]) {
  return t.run((ctx) => admitMember(ctx, input, { userId: t.adminUserId, device: "test" }));
}

async function admitOk(t: TestTenant, input: Parameters<typeof admitMember>[1]) {
  const result = await admit(t, input);
  if (!result.ok) throw new Error(`admission failed: ${JSON.stringify(result.errors)}`);
  return result.member;
}

describe("NID numbers", () => {
  it("accepts 10, 13 and 17 digits, in either script, with spaces or dashes", () => {
    expect(normalizeNid("1234567890")).toBe("1234567890");
    expect(normalizeNid("123 456 7890 123")).toBe("1234567890123");
    expect(normalizeNid("19901234567890123")).toBe("19901234567890123");
    expect(normalizeNid(toBanglaDigits("1234-567-890"))).toBe("1234567890");
    for (const bad of ["", "123456789", "12345678901", "abcdefghij"]) expect(normalizeNid(bad)).toBeNull();
  });
});

describe("admission", () => {
  it("numbers members from 1 per somiti and records the admission", async () => {
    const a = await newTenant(BUSINESS_DATE);
    const b = await newTenant(BUSINESS_DATE);
    const first = await admitOk(a, { nameEn: "Rahima Begum", phone: "01711111111" });
    const second = await admitOk(a, { nameBn: "করিম মিয়া", phone: "01722222222" });
    const other = await admitOk(b, { nameEn: "Jamal", phone: "01733333333" });
    expect([first.memberNo, second.memberNo, other.memberNo]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({ phone: "+8801711111111", admissionDate: BUSINESS_DATE, status: "active" });
    expect(first).not.toHaveProperty("nidCipher");

    const audit = await a.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} = 'member.admit'`));
    expect(audit).toHaveLength(2);
  });

  it("hands out distinct numbers to admissions made at the same time", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const admitted = await Promise.all(
      Array.from({ length: 6 }, (_, i) => admitOk(t, { nameEn: `Member ${i}`, phone: `0171000000${i}` })),
    );
    expect(admitted.map((m) => m.memberNo).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("stores the NID encrypted, refuses it twice in one somiti, and allows it in another", async () => {
    const a = await newTenant(BUSINESS_DATE);
    const b = await newTenant(BUSINESS_DATE);
    const m = await admitOk(a, { nameEn: "Salma", phone: "01744444444", nid: toBanglaDigits("1990123456") });
    expect(m.nidLast4).toBe("3456");

    const [stored] = await a.run(({ tx }) => tx.select().from(member).where(sql`${member.id} = ${m.id}`));
    expect(stored!.nidCipher).not.toContain("1990123456");
    expect(openNid(stored!.nidCipher!)).toBe("1990123456");

    expect(await admit(a, { nameEn: "Someone else", phone: "01755555555", nid: "1990 123 456" })).toEqual({
      ok: false,
      errors: { nid: "duplicate_nid" },
    });
    expect((await admit(b, { nameEn: "Salma", phone: "01744444444", nid: "1990123456" })).ok).toBe(true);
  });

  it("explains what is wrong with the form, field by field", async () => {
    const t = await newTenant(BUSINESS_DATE);
    expect(await admit(t, { phone: "12345", nid: "123" })).toEqual({
      ok: false,
      errors: { nameEn: "name_required", phone: "invalid_phone", nid: "invalid_nid" },
    });
    expect(await admit(t, { nameEn: "X", phone: "01711111111", guardianRelation: "husband" })).toEqual({
      ok: false,
      errors: { guardianNameEn: "guardian_name_required" },
    });
    expect(await admit(t, { nameEn: "X", phone: "01711111111", dateOfBirth: "2026-10-03" })).toEqual({
      ok: false,
      errors: { dateOfBirth: "dob_after_admission" },
    });
    expect(await admit(t, { nameEn: "X", phone: "01711111111", admissionDate: "2026-10-04" })).toEqual({
      ok: false,
      errors: { admissionDate: "admission_after_business_date" },
    });
    expect(await admit(t, { nameEn: "X", phone: "01711111111", admissionDate: "2026-13-01" })).toEqual({
      ok: false,
      errors: { admissionDate: "invalid_date" },
    });
  });

  it("assumes father when only a guardian name is given, and takes Bangla-digit dates", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await admitOk(t, {
      nameBn: "রহিমা",
      guardianNameBn: "আব্দুল করিম",
      phone: toBanglaDigits("01766666666"),
      dateOfBirth: toBanglaDigits("1985-04-12"),
      commLocale: "bn",
    });
    expect(m).toMatchObject({ guardianRelation: "father", dateOfBirth: "1985-04-12", commLocale: "bn" });
  });
});

describe("finding members", () => {
  async function somitiWithMembers() {
    const t = await newTenant(BUSINESS_DATE);
    await admitOk(t, { nameEn: "Rahim Uddin", nameBn: "রহিম উদ্দিন", phone: "01811111111" });
    await admitOk(t, { nameEn: "Ayesha Khatun", nameBn: "আয়েশা খাতুন", phone: "01922222222" });
    await admitOk(t, { nameBn: "করিম", phone: "01633333333", admissionDate: "2026-08-15" });
    return t;
  }

  it("matches part of a name in either script, a member number or part of a phone number", async () => {
    const t = await somitiWithMembers();
    const find = async (q: string) =>
      (await t.run((ctx) => listMembers(ctx, { q }))).members.map((m) => m.memberNo).sort();
    expect(await find("rahim")).toEqual([1]);
    expect(await find("রহিম")).toEqual([1]);
    expect(await find("করিম")).toEqual([3]);
    expect(await find("2")).toEqual([2]);
    expect(await find(toBanglaDigits("3"))).toEqual([3]);
    expect(await find("01922")).toEqual([2]);
    expect(await find("%")).toEqual([]);
  });

  it("filters by status, sorts by name in the reader's language, and counts", async () => {
    const t = await somitiWithMembers();
    await t.run(({ tx }) => tx.update(member).set({ status: "exited" }).where(sql`${member.memberNo} = 2`));
    const active = await t.run((ctx) => listMembers(ctx, { status: "active" }));
    expect(active.total).toBe(2);
    expect(active.members.map((m) => m.memberNo)).toEqual([3, 1]);

    const bn = await t.run((ctx) => listMembers(ctx, { sort: "name", locale: "bn" }));
    expect(bn.members.map((m) => m.nameBn)).toEqual(["আয়েশা খাতুন", "করিম", "রহিম উদ্দিন"]);

    expect(await t.run((ctx) => memberStats(ctx))).toEqual({ total: 3, active: 2, admittedThisMonth: 2 });
  });

  it("never shows one somiti's member to another", async () => {
    const a = await somitiWithMembers();
    const b = await newTenant(BUSINESS_DATE);
    const [first] = (await a.run((ctx) => listMembers(ctx))).members;
    expect(await a.run((ctx) => getMember(ctx, first!.id))).toMatchObject({ id: first!.id });
    expect(await b.run((ctx) => getMember(ctx, first!.id))).toBeNull();
    expect((await b.run((ctx) => listMembers(ctx, { q: "rahim" }))).total).toBe(0);
  });
});

describe("member records", () => {
  it("can't be deleted by the app, or have their number changed", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await admitOk(t, { nameEn: "Keep me", phone: "01711111111" });
    const permissionDenied = { cause: expect.objectContaining({ code: "42501" }) };
    await expect(t.run(({ tx }) => tx.execute(sql`delete from member where id = ${m.id}`))).rejects.toMatchObject(
      permissionDenied,
    );
    await expect(
      t.run(({ tx }) => tx.execute(sql`update member set member_no = 99 where id = ${m.id}`)),
    ).rejects.toMatchObject(permissionDenied);
  });

  it("are what ledger lines point at", async () => {
    const t = await newTenant(BUSINESS_DATE);
    const m = await admitOk(t, { nameEn: "Saver", phone: "01711111111" });
    const depositFor = (memberId: string) => ({
      ...deposit(t, 500_00n),
      lines: [
        { accountId: t.accounts.cash_in_hand, debit: 500_00n },
        { accountId: t.accounts.member_savings, credit: 500_00n, memberId },
      ],
    });
    const posted = await t.run((ctx) => postEntry(ctx, depositFor(m.id)));
    expect(posted.lines.find((l) => l.credit > 0n)?.memberId).toBe(m.id);
    await expect(t.run((ctx) => postEntry(ctx, depositFor("00000000-0000-4000-8000-000000000000")))).rejects.toThrow();
  });
});

describe("who may manage members", () => {
  it("lets the secretary, president and admin admit; other staff only look", () => {
    expect(["secretary", "president", "admin"].every((r) => canManageMembers([r]))).toBe(true);
    expect(canManageMembers(["cashier", "field_collector", "member"])).toBe(false);
    expect(canViewMembers(["cashier"])).toBe(true);
    expect(canViewMembers(["member"])).toBe(false);
  });
});

