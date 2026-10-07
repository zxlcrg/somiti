import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, tenant } from "../src/db/schema";
import { canCloseDay, closeDay, countCash, dayEndSummary, listDayCloses, type CloseDayInput } from "../src/modules/dayend";
import { accountIdsByKey, getEntry, postEntry, trialBalance } from "../src/modules/ledger";
import { deposit, newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

/** A day that opened with ৳1,000 yesterday and took in ৳1,250 today. */
async function day(): Promise<TestTenant> {
  const t = await newTenant("2026-10-02");
  await t.run((ctx) => postEntry(ctx, deposit(t, 1000_00n)));
  await t.run(({ tx, tenantId }) => tx.update(tenant).set({ businessDate: DATE }).where(sql`${tenant.id} = ${tenantId}`));
  await t.run((ctx) => postEntry(ctx, deposit(t, 1250_00n)));
  return t;
}

function close(t: TestTenant, input: Partial<CloseDayInput> = {}) {
  // ৳2,250 exactly: 2 × 1000, 2 × 100, 5 × 10.
  return t.run((ctx) => closeDay(ctx, { date: DATE, pieces: { "1000": "2", "100": "2", "10": "5" }, ...input }, { userId: t.adminUserId, device: "test" }));
}

describe("cash count", () => {
  it("adds up notes, coins and loose change, in either digits", () => {
    expect(countCash({ "500": "৩", "20": "1", "1": "" }, 50n)).toEqual({ counted: 1520_50n, breakdown: { "500": 3, "20": 1, other: 50 } });
    expect(countCash({ "100": "1.5" }, 0n)).toBeNull();
    expect(countCash({ "100": "-1" }, 0n)).toBeNull();
    expect(countCash({ "100": "1000000" }, 0n)).toBeNull();
  });

  it("is done by the cashier", () => {
    expect(canCloseDay(["cashier"])).toBe(true);
    expect(canCloseDay(["admin", "secretary", "field_collector"])).toBe(false);
  });
});

describe("day-end close", () => {
  it("shows the day's cash and what is still open", async () => {
    const t = await day();
    const s = await t.run((ctx) => dayEndSummary(ctx));
    expect(s).toMatchObject({
      date: DATE,
      cash: { opening: 1000_00n, receipts: 1250_00n, payments: 0n, closing: 2250_00n },
      entries: 1,
      pendingVouchers: 0,
      pendingWithdrawals: 0,
      collectorsHolding: [],
    });
  });

  it("locks the day when the drawer matches the books, posting nothing", async () => {
    const t = await day();
    const r = await close(t);
    expect(r).toMatchObject({ ok: true, expected: 2250_00n, counted: 2250_00n, entryNo: null, businessDate: "2026-10-04" });
    const [c] = await t.run((ctx) => listDayCloses(ctx));
    expect(c).toMatchObject({ businessDate: DATE, breakdown: { "1000": 2, "100": 2, "10": 5 }, note: null, closedBy: { nameEn: "Admin" } });
    await expect(t.run((ctx) => postEntry(ctx, deposit(t, 1n, { businessDate: DATE })))).rejects.toMatchObject({ code: "DAY_CLOSED" });
    const [log] = await t.run(({ tx }) => tx.select().from(auditLog).where(sql`${auditLog.action} = 'dayend.close'`));
    expect(log!.after).toMatchObject({ date: DATE, counted: "225000" });
  });

  it("posts a shortage to Cash over / short, with the cashier's reason", async () => {
    const t = await day();
    const short = { pieces: { "1000": "2", "100": "2" } };
    expect(await close(t, short)).toEqual({ ok: false, errors: { note: "note_required" }, expected: 2250_00n });
    const r = await close(t, { ...short, note: "Gave change twice" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.counted).toBe(2200_00n);

    const [c] = await t.run((ctx) => listDayCloses(ctx));
    expect(c).toMatchObject({ note: "Gave change twice", entryNo: r.entryNo });
    const { cash_over_short } = await t.run((ctx) => accountIdsByKey(ctx, ["cash_over_short"] as const));
    const tb = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(tb.rows.find((row) => row.accountId === cash_over_short)?.debit).toBe(50_00n);
    expect(tb.rows.find((row) => row.accountId === t.accounts.cash_in_hand)?.debit).toBe(2200_00n);
    const entryId = await t.run(({ tx }) => tx.execute<{ id: string }>(sql`select entry_id as id from day_close`));
    const { entry } = await t.run((ctx) => getEntry(ctx, entryId.rows[0]!.id));
    expect(entry).toMatchObject({ source: "day_close", businessDate: DATE });
    expect(entry.narration).toContain("short");
  });

  it("posts money over as a credit, loose change included", async () => {
    const t = await day();
    const r = await close(t, { other: "20.50", note: "Member left change" });
    expect(r).toMatchObject({ ok: true, counted: 2270_50n });
    const { cash_over_short } = await t.run((ctx) => accountIdsByKey(ctx, ["cash_over_short"] as const));
    const tb = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(tb.rows.find((row) => row.accountId === cash_over_short)?.credit).toBe(20_50n);
  });

  it("refuses a stale page, a bad count, and a second close", async () => {
    const t = await day();
    expect(await close(t, { pieces: { "100": "x" }, other: "-3", note: "y".repeat(301) })).toEqual({
      ok: false,
      errors: { pieces: "invalid_count", other: "invalid_amount", note: "note_too_long" },
    });
    expect(await close(t, { date: "2026-10-02" })).toEqual({ ok: false, errors: { form: "wrong_date" } });
    expect((await close(t)).ok).toBe(true);
    // The page from before the close is now stale.
    expect(await close(t)).toEqual({ ok: false, errors: { form: "wrong_date" } });
    expect(await t.run((ctx) => listDayCloses(ctx))).toHaveLength(1);
  });

  it("is append-only and stays within its somiti", async () => {
    const t = await day();
    const other = await newTenant(DATE);
    await close(t);
    const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });
    await expect(t.run(({ tx }) => tx.execute(sql`update day_close set counted = 1`))).rejects.toMatchObject(code("42501"));
    await expect(t.run(({ tx }) => tx.execute(sql`delete from day_close`))).rejects.toMatchObject(code("42501"));
    expect(await other.run((ctx) => listDayCloses(ctx))).toEqual([]);
  });
});

