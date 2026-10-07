import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, auditLog, userRole, voucher, voucherLine } from "../src/db/schema";
import { toBanglaDigits } from "../src/lib/digits";
import {
  approveVoucher,
  canApproveVouchers,
  canMakeVouchers,
  cancelVoucher,
  cashBook,
  checkVoucherForm,
  getVoucher,
  listVouchers,
  pendingForChecker,
  postEntry,
  rejectVoucher,
  submitVoucher,
  trialBalance,
  voucherStats,
  type VoucherForm,
} from "../src/modules/ledger";
import { deposit, newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

async function addUser(t: TestTenant, role: "secretary" | "cashier" | "president", name = "Second Officer") {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: name, phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

function rent(t: TestTenant, amount = "1,500.50"): VoucherForm {
  return {
    narration: "Office rent for October",
    lines: [
      { accountId: t.accounts.sms_expense, debit: amount, credit: "" },
      { accountId: t.accounts.cash_in_hand, debit: "", credit: amount },
    ],
  };
}

function submit(t: TestTenant, form: VoucherForm, createdBy = t.adminUserId, submitKey?: string) {
  return t.run((ctx) => submitVoucher(ctx, { ...form, branchId: t.branchId, createdBy, submitKey }));
}

async function submitted(t: TestTenant, form = rent(t), createdBy = t.adminUserId) {
  const r = await submit(t, form, createdBy);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.voucherId;
}

describe("checking a voucher as typed", () => {
  const cash = randomUUID();
  const rentAcct = randomUUID();

  it("accepts Bangla digits and grouping commas, and drops blank rows", () => {
    const r = checkVoucherForm({
      narration: "  Rent ",
      lines: [
        { accountId: rentAcct, debit: toBanglaDigits("1,00,000.5"), credit: "" },
        { accountId: "", debit: "", credit: "" },
        { accountId: cash, debit: "", credit: "100000.50" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      narration: "Rent",
      total: 10_000_050n,
      lines: [
        { accountId: rentAcct, debit: 10_000_050n, credit: undefined, memo: undefined },
        { accountId: cash, debit: undefined, credit: 10_000_050n, memo: undefined },
      ],
    });
  });

  it("puts each mistake on its own row and field", () => {
    const r = checkVoucherForm({
      narration: "",
      lines: [
        { accountId: rentAcct, debit: "10", credit: "10" },
        { accountId: "", debit: "abc", credit: "" },
        { accountId: cash, debit: "", credit: "" , memo: "note only" },
        { accountId: cash, debit: "0", credit: "" },
      ],
    });
    expect(r).toEqual({
      ok: false,
      errors: {
        narration: "required",
        lines: {
          0: { credit: "both_sides" },
          1: { accountId: "account", debit: "amount" },
          2: { debit: "no_amount" },
          3: { debit: "amount" },
        },
      },
    });
  });

  it("needs two balanced lines on at least two accounts", () => {
    const one = (debit: string, credit: string, a = rentAcct, b = cash) =>
      checkVoucherForm({ narration: "x", lines: [{ accountId: a, debit, credit: "" }, { accountId: b, debit: "", credit }] });
    expect(checkVoucherForm({ narration: "x", lines: [{ accountId: cash, debit: "5", credit: "" }] })).toMatchObject({
      errors: { form: "too_few_lines" },
    });
    expect(one("10", "9.99")).toMatchObject({ errors: { form: "unbalanced" } });
    expect(one("10", "10", cash, cash)).toMatchObject({ errors: { form: "one_account" } });
    expect(one("10", "10")).toMatchObject({ ok: true, total: 1000n });
  });
});

describe("maker-checker", () => {
  it("lets officers make vouchers and only managers approve them", () => {
    expect(canMakeVouchers(["cashier"])).toBe(true);
    expect(canApproveVouchers(["cashier"])).toBe(false);
    expect(canApproveVouchers(["secretary"])).toBe(true);
    expect(canMakeVouchers(["field_collector", "member"])).toBe(false);
  });

  it("posts nothing until a different officer approves, then posts exactly the voucher", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const id = await submitted(t);

    const before = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(before.rows).toEqual([]);
    expect(await t.run((ctx) => pendingForChecker(ctx, secretary))).toBe(1);
    expect(await t.run((ctx) => pendingForChecker(ctx, t.adminUserId))).toBe(0);

    const { entryNo } = await t.run((ctx) => approveVoucher(ctx, { voucherId: id, userId: secretary }));
    const after = await t.run((ctx) => trialBalance(ctx, DATE));
    expect(after.totalDebit).toBe(150_050n);
    expect(after.totalCredit).toBe(150_050n);

    const v = await t.run((ctx) => getVoucher(ctx, id));
    expect(v).toMatchObject({ status: "approved", entryNo, entryBusinessDate: DATE, total: 150_050n });
    expect(v!.maker.id).toBe(t.adminUserId);
    expect(v!.checker!.id).toBe(secretary);
    expect(v!.lines.map((l) => [l.debit, l.credit])).toEqual([
      [150_050n, 0n],
      [0n, 150_050n],
    ]);

    const actions = await t.run(({ tx }) => tx.select({ action: auditLog.action }).from(auditLog));
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["voucher.submit", "ledger.post", "voucher.approve"]),
    );
  });

  it("refuses to let the maker approve or reject their own voucher, even holding every role", async () => {
    const t = await newTenant(DATE);
    const id = await submitted(t);
    await expect(t.run((ctx) => approveVoucher(ctx, { voucherId: id, userId: t.adminUserId }))).rejects.toMatchObject({
      code: "SELF_APPROVAL",
    });
    await expect(
      t.run((ctx) => rejectVoucher(ctx, { voucherId: id, userId: t.adminUserId, note: "no" })),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
  });

  it("is enforced by the database even if the app skipped the check", async () => {
    const t = await newTenant(DATE);
    const id = await submitted(t);
    await expect(
      t.run(({ tx }) =>
        tx.execute(sql`update voucher set status = 'rejected', decided_by = created_by, decided_at = now(),
                        decision_note = 'self' where id = ${id}`),
      ),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
  });

  it("makes a decision final", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const president = await addUser(t, "president", "President");
    const id = await submitted(t);
    await t.run((ctx) => rejectVoucher(ctx, { voucherId: id, userId: secretary, note: "Wrong account" }));
    await expect(t.run((ctx) => approveVoucher(ctx, { voucherId: id, userId: president }))).rejects.toMatchObject({
      code: "VOUCHER_DECIDED",
    });
    // Directly in the database too.
    await expect(
      t.run(({ tx }) => tx.execute(sql`update voucher set decision_note = 'changed' where id = ${id}`)),
    ).rejects.toMatchObject({ code: "VOUCHER_DECIDED" });
    expect(await t.run((ctx) => getVoucher(ctx, id))).toMatchObject({ status: "rejected", decisionNote: "Wrong account" });
    expect((await t.run((ctx) => trialBalance(ctx, DATE))).rows).toEqual([]);
  });

  it("needs a reason to reject", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const id = await submitted(t);
    await expect(t.run((ctx) => rejectVoucher(ctx, { voucherId: id, userId: secretary, note: "  " }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("lets only the maker cancel a pending voucher", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const id = await submitted(t);
    await expect(t.run((ctx) => cancelVoucher(ctx, { voucherId: id, userId: secretary }))).rejects.toMatchObject({
      code: "NOT_MAKER",
    });
    await t.run((ctx) => cancelVoucher(ctx, { voucherId: id, userId: t.adminUserId, note: "Typed twice" }));
    expect(await t.run((ctx) => getVoucher(ctx, id))).toMatchObject({ status: "cancelled", decisionNote: "Typed twice" });
  });

  it("posts once when two officers approve at the same moment", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const president = await addUser(t, "president", "President");
    const id = await submitted(t);
    const results = await Promise.allSettled([
      t.run((ctx) => approveVoucher(ctx, { voucherId: id, userId: secretary })),
      t.run((ctx) => approveVoucher(ctx, { voucherId: id, userId: president })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "VOUCHER_DECIDED" } });
    expect((await t.run((ctx) => trialBalance(ctx, DATE))).totalDebit).toBe(150_050n);
  });
});

describe("voucher records", () => {
  it("makes one voucher from a double-clicked submit", async () => {
    const t = await newTenant(DATE);
    const key = randomUUID();
    const first = await submit(t, rent(t), t.adminUserId, key);
    const again = await submit(t, rent(t), t.adminUserId, key);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(again).toEqual({ ok: true, voucherId: (first as { voucherId: string }).voucherId, replayed: true });
    expect((await t.run((ctx) => listVouchers(ctx))).total).toBe(1);
  });

  it("refuses an account that cannot take entries", async () => {
    const t = await newTenant(DATE);
    const header = await t.run(({ tx }) =>
      tx.execute<{ id: string }>(sql`select id from ledger_account where code = '1000'`),
    );
    const form = rent(t);
    form.lines[0]!.accountId = header.rows[0]!.id;
    expect(await submit(t, form)).toEqual({ ok: false, errors: { lines: { 0: { accountId: "account" } } } });
  });

  it("keeps lines append-only and balanced in the database", async () => {
    const t = await newTenant(DATE);
    const id = await submitted(t);
    await expect(
      t.run(({ tx }) => tx.execute(sql`update voucher_line set debit = 1 where voucher_id = ${id}`)),
    ).rejects.toThrow();
    await expect(
      t.run(({ tx, tenantId }) =>
        tx.insert(voucherLine).values({ tenantId, voucherId: id, lineNo: 9, accountId: t.accounts.bank, debit: 5n }),
      ),
    ).rejects.toMatchObject({ code: "APPEND_ONLY" });
    // An unbalanced voucher written straight to the tables fails at commit.
    await expect(
      t.run(async ({ tx, tenantId }) => {
        const vid = randomUUID();
        await tx.insert(voucher).values({ id: vid, tenantId, branchId: t.branchId, narration: "x", total: 10n, createdBy: t.adminUserId });
        await tx.insert(voucherLine).values([
          { tenantId, voucherId: vid, lineNo: 1, accountId: t.accounts.bank, debit: 10n },
          { tenantId, voucherId: vid, lineNo: 2, accountId: t.accounts.cash_in_hand, credit: 9n },
        ]);
      }),
    ).rejects.toMatchObject({ code: "UNBALANCED" });
  });

  it("counts pending and approved vouchers for the tiles", async () => {
    const t = await newTenant(DATE);
    const secretary = await addUser(t, "secretary");
    const a = await submitted(t);
    await submitted(t, rent(t, "200"));
    const c = await submitted(t, rent(t, "50"));
    await t.run((ctx) => approveVoucher(ctx, { voucherId: a, userId: secretary }));
    await t.run((ctx) => rejectVoucher(ctx, { voucherId: c, userId: secretary, note: "dup" }));
    expect(await t.run((ctx) => voucherStats(ctx))).toEqual({
      pending: { count: 1, total: 20_000n },
      approvedThisMonth: { count: 1, total: 150_050n },
      rejected: 1,
    });
    const list = await t.run((ctx) => listVouchers(ctx));
    expect(list.vouchers.map((v) => v.status)).toEqual(["pending", "rejected", "approved"]);
    expect(list.vouchers[0]!.lineCount).toBe(2);
  });
});

describe("cash book", () => {
  it("shows the opening balance, each receipt and payment with a running balance, and the closing balance", async () => {
    const t = await newTenant("2026-10-01");
    await t.run((ctx) => postEntry(ctx, deposit(t, 10_000n)));
    // Move to the next day so the range has something before it.
    await t.run(({ tx, tenantId }) =>
      tx.execute(sql`update tenant set locked_through = '2026-10-01', business_date = '2026-10-02' where id = ${tenantId}`),
    );
    await t.run((ctx) => postEntry(ctx, deposit(t, 2_500n)));
    await t.run((ctx) =>
      postEntry(ctx, {
        branchId: t.branchId,
        source: "manual_voucher",
        narration: "SMS bill",
        createdBy: t.adminUserId,
        lines: [
          { accountId: t.accounts.sms_expense, debit: 700n },
          { accountId: t.accounts.cash_in_hand, credit: 700n },
        ],
      }),
    );
    const book = await t.run((ctx) =>
      cashBook(ctx, { accountId: t.accounts.cash_in_hand, from: "2026-10-02", to: "2026-10-02" }),
    );
    expect(book).toMatchObject({ opening: 10_000n, receipts: 2_500n, payments: 700n, closing: 11_800n });
    expect(book.rows.map((r) => [r.narration, r.receipt, r.payment, r.balance])).toEqual([
      ["Savings deposit", 2_500n, 0n, 12_500n],
      ["SMS bill", 0n, 700n, 11_800n],
    ]);
    expect(book.rows[1]!.contra.map((c) => c.nameEn)).toEqual(["SMS charges"]);
  });
});
