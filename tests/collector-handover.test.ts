import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, userRole } from "../src/db/schema";
import { accountIdsByKey, getEntry, reverseEntry, trialBalance } from "../src/modules/ledger";
import { admitMember } from "../src/modules/members";
import {
  canReceiveHandovers,
  collectorBoard,
  createProduct,
  deposit,
  listHandovers,
  openAccount,
  receiveHandover,
  type HandoverInput,
} from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

async function addUser(t: TestTenant, role: "field_collector" | "cashier", name: string) {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: name, phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/** A collector who has taken ৳300 on their round (two deposits). */
async function round(t: TestTenant) {
  const collector = await addUser(t, "field_collector", "Rafiq");
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Saver", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!m.ok) throw new Error("admit failed");
  const p = await t.run((ctx) => createProduct(ctx, { code: "DS", nameEn: "Daily", frequency: "daily", installment: "100" }, { userId: t.adminUserId }));
  if (!p.ok) throw new Error("product failed");
  const a = await t.run((ctx) => openAccount(ctx, { memberId: m.member.id, productId: p.id }, { userId: t.adminUserId }));
  if (!a.ok) throw new Error("open failed");
  const entries: string[] = [];
  for (const amount of ["100", "200"]) {
    const d = await t.run((ctx) =>
      deposit(ctx, { accountId: a.accountId, amount, method: "cash", idempotencyKey: randomUUID() }, { userId: collector, channel: "collector" }),
    );
    if (!d.ok) throw new Error("deposit failed");
    entries.push(d.deposit.journalEntryId);
  }
  return { collector, entries };
}

function receive(t: TestTenant, input: Partial<HandoverInput> & { collectorId: string }, userId = t.adminUserId) {
  return t.run((ctx) => receiveHandover(ctx, { amount: "300", idempotencyKey: randomUUID(), ...input }, { userId, device: "test" }));
}

describe("collector handovers", () => {
  it("only lets a cashier receive", () => {
    expect(canReceiveHandovers(["cashier"])).toBe(true);
    expect(canReceiveHandovers(["admin", "field_collector"])).toBe(false);
  });

  it("show what each collector holds and move counted cash into cash in hand", async () => {
    const t = await newTenant(DATE);
    const { collector } = await round(t);
    const idle = await addUser(t, "field_collector", "Idle");
    let board = await t.run((ctx) => collectorBoard(ctx));
    expect(board.map((c) => [c.userId, c.held, c.todayCount, c.todayAmount])).toEqual([
      [collector, 300_00n, 2, 300_00n],
      [idle, 0n, 0, 0n],
    ]);

    // A short count: ৳250 comes in, ৳50 stays with the collector.
    const r = await receive(t, { collectorId: collector, amount: "250", note: "৳50 tomorrow" });
    expect(r).toMatchObject({ ok: true, replayed: false });
    board = await t.run((ctx) => collectorBoard(ctx));
    expect(board[0]).toMatchObject({ userId: collector, held: 50_00n, lastHandover: { amount: 250_00n } });

    const [h] = await t.run((ctx) => listHandovers(ctx, { collectorId: collector }));
    expect(h).toMatchObject({ amount: 250_00n, note: "৳50 tomorrow", collectorEn: "Rafiq", receivedEn: "Admin", reversed: false });
    const entry = await t.run(({ tx }) => tx.execute<{ id: string }>(sql`select journal_entry_id as id from collector_handover where id = ${h!.id}`));
    const { entry: je, lines } = await t.run((ctx) => getEntry(ctx, entry.rows[0]!.id));
    expect(je.source).toBe("collector_handover");
    const { cash_with_collector } = await t.run((ctx) => accountIdsByKey(ctx, ["cash_with_collector"] as const));
    expect(lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [t.accounts.cash_in_hand, 250_00n, 0n],
      [cash_with_collector, 0n, 250_00n],
    ]);
    const tb = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(tb.rows.find((row) => row.accountId === cash_with_collector)?.debit).toBe(50_00n);
  });

  it("never takes in more than the collector holds, and posts once per form", async () => {
    const t = await newTenant(DATE);
    const { collector, entries } = await round(t);
    expect(await receive(t, { collectorId: collector, amount: "301" })).toEqual({ ok: false, errors: { amount: "over_held" }, held: 300_00n });

    const key = randomUUID();
    const first = await receive(t, { collectorId: collector, idempotencyKey: key });
    const again = await receive(t, { collectorId: collector, idempotencyKey: key });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(first.ok && again.ok && first.handoverId === again.handoverId).toBe(true);
    expect(await t.run((ctx) => listHandovers(ctx))).toHaveLength(1);

    // A deposit reversed after the handover leaves the collector owed back, shown as below zero.
    await t.run((ctx) => reverseEntry(ctx, { entryId: entries[0]!, reason: "wrong member", createdBy: t.adminUserId }));
    const [c] = await t.run((ctx) => collectorBoard(ctx));
    expect(c!.held).toBe(-100_00n);
  });

  it("explains what's wrong", async () => {
    const t = await newTenant(DATE);
    const { collector } = await round(t);
    const cashier = await addUser(t, "cashier", "Cashier");
    expect(await receive(t, { collectorId: collector, amount: "abc", note: "x".repeat(301) })).toEqual({
      ok: false,
      errors: { amount: "invalid_amount", note: "note_too_long" },
    });
    expect(await receive(t, { collectorId: cashier })).toEqual({ ok: false, errors: { form: "not_collector" } });
    expect(await receive(t, { collectorId: collector }, collector)).toEqual({ ok: false, errors: { form: "self" } });
  });

  it("are append-only and stay within their somiti", async () => {
    const t = await newTenant(DATE);
    const other = await newTenant(DATE);
    const { collector } = await round(t);
    const r = await receive(t, { collectorId: collector });
    if (!r.ok) throw new Error("handover failed");
    await expect(t.run(({ tx }) => tx.execute(sql`update collector_handover set amount = 1 where id = ${r.handoverId}`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
    expect(await other.run((ctx) => listHandovers(ctx))).toEqual([]);
    expect(await other.run((ctx) => collectorBoard(ctx))).toEqual([]);
  });
});
