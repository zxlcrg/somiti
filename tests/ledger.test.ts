import { sql } from "drizzle-orm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { withTenant } from "../src/db/client";
import { auditLog, journalEntry, journalLine } from "../src/db/schema";
import {
  closeBusinessDay,
  closeFiscalPeriod,
  getEntry,
  LedgerError,
  postEntry,
  reverseEntry,
  trialBalance,
  type LedgerErrorCode,
} from "../src/modules/ledger";
import { ACCOUNT_KEYS, app, deposit, newTenant, owner } from "./helpers";

async function expectLedgerError(promise: Promise<unknown>, code: LedgerErrorCode) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(LedgerError);
  expect((err as LedgerError).code).toBe(code);
}

async function expectPgError(promise: Promise<unknown>, pattern: RegExp) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  const messages: string[] = [];
  for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    messages.push(e.message ?? "");
  }
  expect(messages.join(" | ")).toMatch(pattern);
}

describe("posting", () => {
  it("posts a balanced entry with sequential voucher numbers", async () => {
    const t = await newTenant();
    const first = await t.run((ctx) => postEntry(ctx, deposit(t, 50_000n)));
    const second = await t.run((ctx) => postEntry(ctx, deposit(t, 25_050n)));

    expect(first.replayed).toBe(false);
    expect(first.entry.entryNo).toBe(1n);
    expect(second.entry.entryNo).toBe(2n);
    expect(first.entry.businessDate).toBe("2026-10-03");
    expect(first.lines.map((l) => [l.debit, l.credit])).toEqual([
      [50_000n, 0n],
      [0n, 50_000n],
    ]);

    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
    expect(tb.totalDebit).toBe(75_050n);
    expect(tb.totalCredit).toBe(75_050n);
    expect(tb.rows.find((r) => r.accountId === t.accounts.cash_in_hand)?.debit).toBe(75_050n);
    expect(tb.rows.find((r) => r.accountId === t.accounts.member_savings)?.credit).toBe(75_050n);
  });

  it("writes an audit log row in the same transaction", async () => {
    const t = await newTenant();
    const posted = await t.run((ctx) => postEntry(ctx, deposit(t, 1_000n, { device: "test-device" })));
    const rows = await t.run(({ tx }) =>
      tx.select().from(auditLog).where(sql`${auditLog.entityId} = ${posted.entry.id}`),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "ledger.post", actorUserId: t.adminUserId, device: "test-device" });
  });

  it("rejects an unbalanced entry before it reaches the database", async () => {
    const t = await newTenant();
    await expectLedgerError(
      t.run((ctx) =>
        postEntry(ctx, {
          ...deposit(t, 100n),
          lines: [
            { accountId: t.accounts.cash_in_hand, debit: 100n },
            { accountId: t.accounts.member_savings, credit: 99n },
          ],
        }),
      ),
      "UNBALANCED",
    );
  });

  it("rejects lines with both or neither side, zero or negative amounts", async () => {
    const t = await newTenant();
    const bad = [
      { accountId: t.accounts.cash_in_hand, debit: 100n, credit: 100n },
      { accountId: t.accounts.cash_in_hand },
      { accountId: t.accounts.cash_in_hand, debit: 0n },
      { accountId: t.accounts.cash_in_hand, debit: -100n },
    ];
    for (const line of bad) {
      await expectLedgerError(
        t.run((ctx) => postEntry(ctx, { ...deposit(t, 100n), lines: [line, { accountId: t.accounts.member_savings, credit: 100n }] })),
        "INVALID_INPUT",
      );
    }
  });

  it("rejects posting to a header account", async () => {
    const t = await newTenant();
    const header = await t.run(({ tx }) =>
      tx.execute<{ id: string }>(sql`select id from ledger_account where code = '1000'`),
    );
    await expectLedgerError(
      t.run((ctx) =>
        postEntry(ctx, {
          ...deposit(t, 100n),
          lines: [
            { accountId: header.rows[0]!.id, debit: 100n },
            { accountId: t.accounts.member_savings, credit: 100n },
          ],
        }),
      ),
      "ACCOUNT_NOT_POSTABLE",
    );
  });
});

describe("database invariants (bypassing the service)", () => {
  async function rawEntry(t: Awaited<ReturnType<typeof newTenant>>, lines: Array<[string, bigint, bigint]>) {
    return t.run(async ({ tx, tenantId }) => {
      const [e] = await tx
        .insert(journalEntry)
        .values({
          tenantId,
          branchId: t.branchId,
          entryNo: BigInt(Math.floor(Math.random() * 1e12)),
          businessDate: "2026-10-03",
          source: "manual_voucher",
          narration: "raw",
          createdBy: t.adminUserId,
        })
        .returning();
      if (lines.length) {
        await tx.insert(journalLine).values(
          lines.map(([accountId, debit, credit], i) => ({
            tenantId,
            entryId: e!.id,
            lineNo: i + 1,
            accountId,
            debit,
            credit,
          })),
        );
      }
      return e!;
    });
  }

  it("rejects an unbalanced entry at commit", async () => {
    const t = await newTenant();
    await expectLedgerError(
      rawEntry(t, [
        [t.accounts.cash_in_hand, 100n, 0n],
        [t.accounts.member_savings, 0n, 90n],
      ]),
      "UNBALANCED",
    );
  });

  it("rejects an entry with no lines or a single line", async () => {
    const t = await newTenant();
    await expectLedgerError(rawEntry(t, []), "UNBALANCED");
    await expectLedgerError(rawEntry(t, [[t.accounts.cash_in_hand, 100n, 0n]]), "UNBALANCED");
  });

  it("rejects a line with both a debit and a credit", async () => {
    const t = await newTenant();
    await expectPgError(
      rawEntry(t, [
        [t.accounts.cash_in_hand, 100n, 100n],
        [t.accounts.member_savings, 0n, 0n],
      ]),
      /journal_line_one_side/,
    );
  });

  it("refuses to add lines to an entry made in an earlier transaction", async () => {
    const t = await newTenant();
    const posted = await t.run((ctx) => postEntry(ctx, deposit(t, 500n)));
    await expectLedgerError(
      t.run(({ tx, tenantId }) =>
        tx.insert(journalLine).values([
          { tenantId, entryId: posted.entry.id, lineNo: 10, accountId: t.accounts.cash_in_hand, debit: 7n },
          { tenantId, entryId: posted.entry.id, lineNo: 11, accountId: t.accounts.member_savings, credit: 7n },
        ]),
      ),
      "APPEND_ONLY",
    );
  });

  it("denies UPDATE and DELETE on ledger tables to the app role", async () => {
    const t = await newTenant();
    const posted = await t.run((ctx) => postEntry(ctx, deposit(t, 500n)));
    for (const statement of [
      sql`update journal_line set debit = 1 where entry_id = ${posted.entry.id}`,
      sql`delete from journal_line where entry_id = ${posted.entry.id}`,
      sql`update journal_entry set narration = 'x' where id = ${posted.entry.id}`,
      sql`delete from journal_entry where id = ${posted.entry.id}`,
      sql`delete from audit_log`,
    ]) {
      await expectPgError(t.run(({ tx }) => tx.execute(statement)), /permission denied/);
    }
  });

  it("blocks UPDATE and DELETE even for the table owner", async () => {
    const t = await newTenant();
    const posted = await t.run((ctx) => postEntry(ctx, deposit(t, 500n)));
    await expectLedgerError(
      withTenant(owner.db, t.tenantId, ({ tx }) =>
        tx.execute(sql`update journal_line set debit = 1 where entry_id = ${posted.entry.id}`),
      ),
      "APPEND_ONLY",
    );
    await expectLedgerError(
      withTenant(owner.db, t.tenantId, ({ tx }) =>
        tx.execute(sql`delete from journal_entry where id = ${posted.entry.id}`),
      ),
      "APPEND_ONLY",
    );
    await expectLedgerError(
      withTenant(owner.db, t.tenantId, ({ tx }) => tx.execute(sql`truncate journal_line cascade`)),
      "APPEND_ONLY",
    );
  });

  it("ignores a created_at supplied by the caller", async () => {
    const t = await newTenant();
    const e = await t.run(async ({ tx, tenantId }) => {
      const [row] = await tx
        .insert(journalEntry)
        .values({
          tenantId,
          branchId: t.branchId,
          entryNo: 999n,
          businessDate: "2026-10-03",
          source: "manual_voucher",
          narration: "backdated",
          createdBy: t.adminUserId,
          createdAt: new Date("2020-01-01T00:00:00Z"),
        })
        .returning();
      await tx.insert(journalLine).values([
        { tenantId, entryId: row!.id, lineNo: 1, accountId: t.accounts.cash_in_hand, debit: 1n },
        { tenantId, entryId: row!.id, lineNo: 2, accountId: t.accounts.member_savings, credit: 1n },
      ]);
      return row!;
    });
    expect(e.createdAt.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

describe("reversals", () => {
  it("posts a mirror entry that cancels the original", async () => {
    const t = await newTenant();
    const original = await t.run((ctx) => postEntry(ctx, deposit(t, 12_345n)));
    const reversal = await t.run((ctx) =>
      reverseEntry(ctx, { entryId: original.entry.id, reason: "Wrong member", createdBy: t.adminUserId }),
    );
    expect(reversal.entry.source).toBe("reversal");
    expect(reversal.entry.reversesId).toBe(original.entry.id);
    expect(reversal.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [t.accounts.cash_in_hand, 0n, 12_345n],
      [t.accounts.member_savings, 12_345n, 0n],
    ]);

    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
    expect(tb.rows).toEqual([]);

    // The original is still there, unchanged.
    const again = await t.run((ctx) => getEntry(ctx, original.entry.id));
    expect(again.lines).toEqual(original.lines);
  });

  it("reverses an entry at most once", async () => {
    const t = await newTenant();
    const original = await t.run((ctx) => postEntry(ctx, deposit(t, 100n)));
    const input = { entryId: original.entry.id, reason: "Duplicate", createdBy: t.adminUserId };
    await t.run((ctx) => reverseEntry(ctx, input));
    await expectLedgerError(t.run((ctx) => reverseEntry(ctx, input)), "ALREADY_REVERSED");
  });

  it("does not reverse a reversal", async () => {
    const t = await newTenant();
    const original = await t.run((ctx) => postEntry(ctx, deposit(t, 100n)));
    const reversal = await t.run((ctx) =>
      reverseEntry(ctx, { entryId: original.entry.id, reason: "Oops", createdBy: t.adminUserId }),
    );
    await expectLedgerError(
      t.run((ctx) => reverseEntry(ctx, { entryId: reversal.entry.id, reason: "Undo", createdBy: t.adminUserId })),
      "CANNOT_REVERSE_REVERSAL",
    );
  });
});

describe("business date and period lock", () => {
  it("blocks posting into a closed day and fixes mistakes there with a reversal today", async () => {
    const t = await newTenant("2026-10-03");
    const posted = await t.run((ctx) => postEntry(ctx, deposit(t, 700n)));
    const closed = await t.run((ctx) => closeBusinessDay(ctx, { date: "2026-10-03", closedBy: t.adminUserId }));
    expect(closed).toEqual({ lockedThrough: "2026-10-03", businessDate: "2026-10-04" });

    await expectLedgerError(
      t.run((ctx) => postEntry(ctx, deposit(t, 100n, { businessDate: "2026-10-03" }))),
      "DAY_CLOSED",
    );
    const reversal = await t.run((ctx) =>
      reverseEntry(ctx, { entryId: posted.entry.id, reason: "Wrong amount", createdBy: t.adminUserId }),
    );
    expect(reversal.entry.businessDate).toBe("2026-10-04");

    // The closed day's trial balance is unchanged; the reversal shows from the 4th.
    const before = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
    const after = await t.run((ctx) => trialBalance(ctx, "2026-10-04"));
    expect(before.totalDebit).toBe(700n);
    expect(after.rows).toEqual([]);
  });

  it("only closes the current business day", async () => {
    const t = await newTenant("2026-10-03");
    await expectLedgerError(
      t.run((ctx) => closeBusinessDay(ctx, { date: "2026-10-02", closedBy: t.adminUserId })),
      "WRONG_BUSINESS_DATE",
    );
  });

  it("rejects dates after the business date", async () => {
    const t = await newTenant("2026-10-03");
    await expectLedgerError(
      t.run((ctx) => postEntry(ctx, deposit(t, 100n, { businessDate: "2026-10-04" }))),
      "AFTER_BUSINESS_DATE",
    );
  });

  it("rejects dates outside an open fiscal period", async () => {
    const t = await newTenant("2026-10-03");
    // Fiscal year is July 2026 to June 2027; 30 June 2026 belongs to no period.
    await expectLedgerError(
      t.run((ctx) => postEntry(ctx, deposit(t, 100n, { businessDate: "2026-06-30" }))),
      "NO_OPEN_PERIOD",
    );
    await t.run((ctx) => closeFiscalPeriod(ctx, { periodId: t.fiscalPeriodId, closedBy: t.adminUserId }));
    await expectLedgerError(t.run((ctx) => postEntry(ctx, deposit(t, 100n))), "NO_OPEN_PERIOD");
  });

  it("never reopens a closed day or period, or moves the business date back", async () => {
    const t = await newTenant("2026-10-03");
    await t.run((ctx) => closeBusinessDay(ctx, { date: "2026-10-03", closedBy: t.adminUserId }));
    await expectLedgerError(
      t.run(({ tx }) => tx.execute(sql`update tenant set locked_through = '2026-10-02'`)),
      "DAY_CLOSED",
    );
    await expectLedgerError(
      t.run(({ tx }) => tx.execute(sql`update tenant set locked_through = null`)),
      "DAY_CLOSED",
    );
    await expectPgError(
      t.run(({ tx }) => tx.execute(sql`update tenant set business_date = '2026-10-03'`)),
      /tenant_business_date_after_lock|cannot move backwards/,
    );
    await t.run((ctx) => closeFiscalPeriod(ctx, { periodId: t.fiscalPeriodId, closedBy: t.adminUserId }));
    await expectLedgerError(
      t.run(({ tx }) => tx.execute(sql`update fiscal_period set status = 'open'`)),
      "DAY_CLOSED",
    );
    // Period dates are not updatable by the app at all.
    await expectPgError(
      t.run(({ tx }) => tx.execute(sql`update fiscal_period set end_date = '2030-01-01'`)),
      /permission denied/,
    );
  });

  it("rejects overlapping fiscal periods", async () => {
    const t = await newTenant("2026-10-03");
    await expectPgError(
      t.run(({ tx, tenantId }) =>
        tx.execute(
          sql`insert into fiscal_period (tenant_id, start_date, end_date) values (${tenantId}, '2027-01-01', '2027-12-31')`,
        ),
      ),
      /fiscal_period_no_overlap/,
    );
  });
});

describe("idempotency", () => {
  it("returns the first result for a repeated key and body", async () => {
    const t = await newTenant();
    const input = deposit(t, 4_200n, { idempotencyKey: "collector-1:abc123" });
    const first = await t.run((ctx) => postEntry(ctx, input));
    const second = await t.run((ctx) => postEntry(ctx, { ...input, device: "another-sync" }));
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
    expect(tb.totalDebit).toBe(4_200n);
  });

  it("refuses a reused key with a different body", async () => {
    const t = await newTenant();
    await t.run((ctx) => postEntry(ctx, deposit(t, 100n, { idempotencyKey: "key-00000001" })));
    await expectLedgerError(
      t.run((ctx) => postEntry(ctx, deposit(t, 200n, { idempotencyKey: "key-00000001" }))),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("posts once when the same key arrives twice at the same time", async () => {
    const t = await newTenant();
    const input = deposit(t, 300n, { idempotencyKey: "concurrent-sync-1" });
    const results = await Promise.all([1, 2, 3, 4].map(() => t.run((ctx) => postEntry(ctx, input))));
    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
    expect(tb.totalDebit).toBe(300n);
  });

  it("keys are per somiti", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const ra = await a.run((ctx) => postEntry(ctx, deposit(a, 100n, { idempotencyKey: "shared-key-1" })));
    const rb = await b.run((ctx) => postEntry(ctx, deposit(b, 100n, { idempotencyKey: "shared-key-1" })));
    expect(ra.replayed).toBe(false);
    expect(rb.replayed).toBe(false);
  });
});

describe("property: every posting balances", () => {
  const amount = fc.bigInt({ min: 1n, max: 10_000_000_000n });

  /** A random balanced entry: random debit lines, then credits that split the same total. */
  const balancedLines = fc
    .tuple(
      fc.array(fc.tuple(fc.integer({ min: 0, max: ACCOUNT_KEYS.length - 1 }), amount), { minLength: 1, maxLength: 6 }),
      fc.array(fc.tuple(fc.integer({ min: 0, max: ACCOUNT_KEYS.length - 1 }), fc.integer({ min: 1, max: 100 })), {
        minLength: 1,
        maxLength: 6,
      }),
    )
    .filter(([debits, credits]) => debits.reduce((s, [, a]) => s + a, 0n) >= BigInt(credits.length));

  it("posts any balanced entry and keeps the trial balance balanced", async () => {
    const t = await newTenant();
    const expected = new Map<string, bigint>();
    await fc.assert(
      fc.asyncProperty(balancedLines, async ([debits, weights]) => {
        const total = debits.reduce((s, [, a]) => s + a, 0n);
        // Split the total across credit lines by weight; the last line takes the remainder.
        const weightSum = BigInt(weights.reduce((s, [, w]) => s + w, 0));
        let remaining = total;
        const credits = weights.map(([i, w], idx) => {
          const share = idx === weights.length - 1 ? remaining : (total * BigInt(w)) / weightSum;
          remaining -= share;
          return [i, share] as const;
        });
        if (credits.some(([, a]) => a <= 0n)) return; // a zero share is not a valid line

        const lines = [
          ...debits.map(([i, a]) => ({ accountId: t.accounts[ACCOUNT_KEYS[i]!], debit: a })),
          ...credits.map(([i, a]) => ({ accountId: t.accounts[ACCOUNT_KEYS[i]!], credit: a })),
        ];
        await t.run((ctx) => postEntry(ctx, { ...deposit(t, 1n), lines }));
        for (const l of lines) {
          const delta = ("debit" in l ? l.debit : 0n) - ("credit" in l ? (l.credit as bigint) : 0n);
          expected.set(l.accountId, (expected.get(l.accountId) ?? 0n) + delta);
        }

        const tb = await t.run((ctx) => trialBalance(ctx, "2026-10-03"));
        expect(tb.totalDebit).toBe(tb.totalCredit);
        for (const row of tb.rows) expect(row.debit - row.credit).toBe(expected.get(row.accountId));
      }),
      { numRuns: 60 },
    );
  });

  it("rejects any entry whose debits and credits differ", async () => {
    const t = await newTenant();
    await fc.assert(
      fc.asyncProperty(amount, amount, async (d, c) => {
        fc.pre(d !== c);
        const lines = [
          { accountId: t.accounts.cash_in_hand, debit: d },
          { accountId: t.accounts.member_savings, credit: c },
        ];
        await expectLedgerError(t.run((ctx) => postEntry(ctx, { ...deposit(t, 1n), lines })), "UNBALANCED");
      }),
      { numRuns: 30 },
    );
  });
});

describe("connection hygiene", () => {
  it("does not leak the tenant setting to the next user of a pooled connection", async () => {
    const t = await newTenant();
    await t.run((ctx) => postEntry(ctx, deposit(t, 100n)));
    const client = await app.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [t.tenantId]);
      await client.query("commit");
      const after = await client.query("select count(*)::int as n from journal_entry");
      expect(after.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});
