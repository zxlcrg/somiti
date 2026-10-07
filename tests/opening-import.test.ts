import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, tenant } from "../src/db/schema";
import { parseCsv, toCsv } from "../src/lib/csv";
import { accountIdsByKey, trialBalance } from "../src/modules/ledger";
import { listMembers, shareHolding } from "../src/modules/members";
import { canImportOpening, importOpening, parseOpeningSheet, parseSheetDate, previewOpening } from "../src/modules/opening";
import { createProduct, getAccount, listProducts, memberAccounts, setProductActive } from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

const PRODUCTS = [
  { code: "DS", active: true },
  { code: "GS", active: true },
  { code: "OLD", active: false },
];
const sheet = (text: string) => parseOpeningSheet(text, { products: PRODUCTS, businessDate: "2026-10-03", sharePrice: 100_00n });

const GOOD = [
  "name_en,name_bn,phone,admission_date,shares,DS,GS",
  "Ayesha Begum,আয়েশা বেগম,01711000001,15/03/2019,5,\"1,250\",3000.50",
  ",রহিম মিয়া,1811000002,,০২,৮০০,",
  "Karim,,+8801911000003,2020-01-01,,,0",
].join("\r\n");

describe("CSV", () => {
  it("reads quoted cells and writes what Excel opens", () => {
    expect(parseCsv('﻿a,"b,c","say ""hi"""\r\n1,"two\nlines",\n')).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "two\nlines", ""],
    ]);
    expect(toCsv([["name", "a,b"]])).toBe('﻿name,"a,b"\r\n');
  });

  it("reads dates the way people type them", () => {
    expect(parseSheetDate("31/01/2024")).toBe("2024-01-31");
    expect(parseSheetDate("৩১-০১-২০২৪")).toBe("2024-01-31");
    expect(parseSheetDate("2024-1-5")).toBe("2024-01-05");
    expect(parseSheetDate("31/02/2024")).toBeNull();
    expect(parseSheetDate("01/31/2024")).toBeNull();
  });
});

describe("opening sheet", () => {
  it("reads members, shares and balances, with totals", () => {
    const p = sheet(GOOD);
    expect(p.headerErrors).toEqual([]);
    expect(p.errors).toEqual([]);
    expect(p.productCodes).toEqual(["DS", "GS"]);
    expect(p.rows).toEqual([
      { line: 2, nameEn: "Ayesha Begum", nameBn: "আয়েশা বেগম", phone: "+8801711000001", admissionDate: "2019-03-15", shares: 5, balances: { DS: 1250_00n, GS: 3000_50n } },
      { line: 3, nameEn: null, nameBn: "রহিম মিয়া", phone: "+8801811000002", admissionDate: null, shares: 2, balances: { DS: 800_00n } },
      { line: 4, nameEn: "Karim", nameBn: null, phone: "+8801911000003", admissionDate: "2020-01-01", shares: 0, balances: { GS: 0n } },
    ]);
    expect(p.totals).toEqual({
      members: 3,
      shares: 7,
      shareAmount: 700_00n,
      savings: { DS: { accounts: 2, amount: 2050_00n }, GS: { accounts: 2, amount: 3000_50n } },
      savingsAmount: 5050_50n,
    });
  });

  it("stops at a header it doesn't understand", () => {
    expect(sheet("name,phone,XX,OLD\nA,01711000001,1,2").headerErrors).toEqual([
      { code: "unknown_column", column: "name" },
      { code: "unknown_column", column: "XX" },
      { code: "inactive_product", column: "OLD" },
      { code: "missing_column", column: "name" },
    ]);
    expect(sheet("name_en,phone\n\n").headerErrors).toEqual([{ code: "empty_file" }]);
  });

  it("lists every problem by line and column", () => {
    const p = sheet(
      [
        "name_en,phone,admission_date,shares,DS",
        ",01711000001,,,",
        "B,12345,32/13/2020,1.5,abc",
        "",
        "C,01711000003,2027-01-01,-2,-5",
      ].join("\n"),
    );
    expect(p.rows).toEqual([]);
    expect(p.errors).toEqual([
      { line: 2, column: "name_en", code: "name_required" },
      { line: 3, column: "phone", code: "invalid_phone" },
      { line: 3, column: "admission_date", code: "invalid_date" },
      { line: 3, column: "shares", code: "invalid_shares" },
      { line: 3, column: "DS", code: "invalid_amount" },
      { line: 5, column: "admission_date", code: "admission_after_business_date" },
      { line: 5, column: "shares", code: "invalid_shares" },
      { line: 5, column: "DS", code: "invalid_amount" },
    ]);
  });

  it("is the admin's job", () => {
    expect(canImportOpening(["admin"])).toBe(true);
    expect(canImportOpening(["secretary", "cashier", "president"])).toBe(false);
  });
});

async function somiti(): Promise<TestTenant> {
  const t = await newTenant();
  await t.run(({ tx, tenantId }) => tx.update(tenant).set({ sharePrice: 100_00n }).where(sql`${tenant.id} = ${tenantId}`));
  for (const [code, frequency] of [["DS", "daily"], ["GS", "flexible"]] as const) {
    await t.run((ctx) => createProduct(ctx, { code, nameEn: code, frequency, installment: frequency === "daily" ? "20" : "" }, { userId: t.adminUserId }));
  }
  return t;
}

const run = (t: TestTenant, csv: string, extra: { cash?: string; bank?: string; batchKey?: string } = {}) =>
  t.run((ctx) => importOpening(ctx, { csv, batchKey: "batch-1", ...extra }, { userId: t.adminUserId, device: "test" }));

describe("opening import", () => {
  it("admits members and posts their shares, savings, cash and bank against opening equity", async () => {
    const t = await somiti();
    const r = await run(t, GOOD, { cash: "4,000", bank: "10000" });
    expect(r).toEqual({
      ok: true,
      summary: {
        members: 3,
        shares: 7,
        accounts: 4,
        shareAmount: 700_00n,
        savingsAmount: 5050_50n,
        cash: 4000_00n,
        bank: 10000_00n,
        firstMemberNo: 1,
        lastMemberNo: 3,
        replayed: false,
      },
    });

    const { members } = await t.run((ctx) => listMembers(ctx, {}));
    const ayesha = members.find((m) => m.nameEn === "Ayesha Begum")!;
    expect(ayesha).toMatchObject({ memberNo: 1, admissionDate: "2019-03-15", phone: "+8801711000001" });
    expect(await t.run((ctx) => shareHolding(ctx, ayesha.id))).toMatchObject({
      shares: 5,
      transactions: [{ kind: "opening", shares: 5, amount: 500_00n, paymentMethod: null }],
    });
    const accounts = await t.run((ctx) => memberAccounts(ctx, ayesha.id));
    expect(accounts.map((a) => [a.productCode, a.balance, a.openedOn])).toEqual([
      ["DS", 1250_00n, "2026-10-03"],
      ["GS", 3000_50n, "2026-10-03"],
    ]);
    // Dues start from today, so the old balance neither counts as paid ahead nor leaves the member behind.
    expect(accounts[0]!.due).toMatchObject({ paid: 0n, behind: 20_00n });
    const ds = await t.run((ctx) => getAccount(ctx, accounts[0]!.id));
    expect(ds!.transactions).toMatchObject([{ kind: "opening", amount: 1250_00n, paymentMethod: null, balanceAfter: 1250_00n }]);

    const { opening_balance_equity: obe } = await t.run((ctx) => accountIdsByKey(ctx, ["opening_balance_equity"] as const));
    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
    const line = (id: string) => tb.rows.find((row) => row.accountId === id);
    expect(line(t.accounts.cash_in_hand)?.debit).toBe(4000_00n);
    expect(line(t.accounts.share_capital)?.credit).toBe(700_00n);
    expect(line(t.accounts.member_savings)?.credit).toBe(5050_50n);
    // 14,000 brought in less 5,750.50 owed to members: the residual the accountant moves to reserves.
    expect(line(obe)?.credit).toBe(8249_50n);

    const logs = await t.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} = 'opening.import'`));
    expect(logs[0]!.after).toMatchObject({ batch: "batch-1", members: 3, cash: "400000" });
  });

  it("does nothing twice for one submit, and refuses a reused key", async () => {
    const t = await somiti();
    expect(await run(t, GOOD)).toMatchObject({ ok: true });
    expect(await run(t, GOOD)).toMatchObject({ ok: true, summary: { replayed: true } });
    expect(await run(t, GOOD, { cash: "1" })).toEqual({ ok: false, error: "already_used" });
    const { total } = await t.run((ctx) => listMembers(ctx, {}));
    expect(total).toBe(3);
  });

  it("warns when a phone is already on the member list", async () => {
    const t = await somiti();
    await run(t, GOOD);
    const p = await t.run((ctx) => previewOpening(ctx, GOOD));
    expect(p.existingPhones).toEqual([
      { line: 2, memberNo: 1 },
      { line: 3, memberNo: 2 },
      { line: 4, memberNo: 3 },
    ]);
  });

  it("posts nothing when any row is wrong", async () => {
    const t = await somiti();
    const r = await run(t, GOOD + "\r\nBad,123,,,,");
    expect(r).toMatchObject({ ok: false, error: "has_errors", preview: { errors: [{ line: 5, column: "phone" }] } });
    expect(await run(t, GOOD, { cash: "lots" })).toEqual({ ok: false, error: "invalid_cash" });
    const { total } = await t.run((ctx) => listMembers(ctx, {}));
    expect(total).toBe(0);
  });

  it("only takes active products", async () => {
    const t = await somiti();
    const [gs] = (await t.run((ctx) => listProducts(ctx))).filter((p) => p.code === "GS");
    await t.run((ctx) => setProductActive(ctx, gs!.id, false, { userId: t.adminUserId }));
    const p = await t.run((ctx) => previewOpening(ctx, GOOD));
    expect(p.headerErrors).toEqual([{ code: "inactive_product", column: "GS" }]);
  });
});
