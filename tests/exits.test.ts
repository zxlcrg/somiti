import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appUser, auditLog, member, memberExit, memberExitPayout, savingsAccount, userRole } from "../src/db/schema";
import { getEntry, trialBalance } from "../src/modules/ledger";
import {
  admitMember,
  approveExit,
  buyShares,
  cancelExit,
  exitBlockers,
  exitSettlement,
  exitsForChecker,
  memberExits,
  rejectExit,
  requestExit,
  shareHolding,
  type ExitRequestInput,
} from "../src/modules/members";
import { createProduct, deposit, getAccount, openAccount, requestWithdrawal } from "../src/modules/savings";
import { newTenant, type TestTenant } from "./helpers";

const DATE = "2026-10-03";

async function addOfficer(t: TestTenant, role: "president" | "secretary" = "president") {
  return t.run(async ({ tx, tenantId }) => {
    const [u] = await tx
      .insert(appUser)
      .values({ tenantId, nameEn: "Second Officer", phone: `+8801${Math.floor(Math.random() * 1e9)}` })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: u!.id, role });
    return u!.id;
  });
}

/** A member with 5 shares (৳500) and two savings accounts holding ৳1,000 and ৳250. */
async function settledMember(t: TestTenant) {
  const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Leaver", phone: "01711111111" }, { userId: t.adminUserId }));
  if (!m.ok) throw new Error("admit failed");
  const memberId = m.member.id;
  await t.run((ctx) =>
    buyShares(ctx, { memberId, shares: 5, method: "cash", idempotencyKey: randomUUID() }, { userId: t.adminUserId }),
  );
  const accounts: string[] = [];
  for (const [code, amount] of [["GS", "1000"], ["DPS", "250"]] as const) {
    const p = await t.run((ctx) => createProduct(ctx, { code, nameEn: code, frequency: "flexible" }, { userId: t.adminUserId }));
    if (!p.ok) throw new Error("product failed");
    const a = await t.run((ctx) => openAccount(ctx, { memberId, productId: p.id }, { userId: t.adminUserId }));
    if (!a.ok) throw new Error("open failed");
    const d = await t.run((ctx) =>
      deposit(ctx, { accountId: a.accountId, amount, method: "cash", idempotencyKey: randomUUID() }, { userId: t.adminUserId, channel: "office" }),
    );
    if (!d.ok) throw new Error("deposit failed");
    accounts.push(a.accountId);
  }
  return { memberId, accounts };
}

function ask(t: TestTenant, input: Partial<ExitRequestInput> & { memberId: string }, userId = t.adminUserId) {
  return t.run((ctx) =>
    requestExit(ctx, { reason: "Moving to Chattogram", method: "cash", submitKey: randomUUID(), ...input }, { userId, device: "test" }),
  );
}

async function asked(t: TestTenant, memberId: string, userId = t.adminUserId) {
  const r = await ask(t, { memberId }, userId);
  if (!r.ok) throw new Error(`request: ${JSON.stringify(r.errors)}`);
  return r.exitId;
}

describe("exit settlement", () => {
  it("adds up the share capital and every savings balance", async () => {
    const t = await newTenant(DATE);
    const { memberId } = await settledMember(t);
    const s = await t.run((ctx) => exitSettlement(ctx, memberId));
    expect(s).toMatchObject({ shareRefund: 500_00n, shares: 5, savingsPayout: 1250_00n, total: 1750_00n });
    expect(s.savings.map((a) => a.balance).sort()).toEqual([250_00n, 1000_00n].sort());
  });
});

describe("leaving the somiti", () => {
  it("posts nothing on request; approval by another officer pays everything out and closes the books", async () => {
    const t = await newTenant(DATE);
    const president = await addOfficer(t);
    const { memberId, accounts } = await settledMember(t);
    const exitId = await asked(t, memberId);

    expect((await t.run((ctx) => shareHolding(ctx, memberId))).amount).toBe(500_00n);
    expect(await t.run((ctx) => exitsForChecker(ctx, president))).toBe(1);
    expect(await t.run((ctx) => exitsForChecker(ctx, t.adminUserId))).toBe(0);

    const result = await t.run((ctx) => approveExit(ctx, { exitId, userId: president, device: "test" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.settlement).toMatchObject({ shareRefund: 500_00n, savingsPayout: 1250_00n });
    expect(result.settlement!.entryNos).toHaveLength(3);

    const [m] = await t.run(({ tx }) => tx.select({ status: member.status }).from(member).where(sql`${member.id} = ${memberId}`));
    expect(m!.status).toBe("exited");
    expect(await t.run((ctx) => shareHolding(ctx, memberId))).toMatchObject({ shares: 0, amount: 0n });
    for (const id of accounts) {
      expect(await t.run((ctx) => getAccount(ctx, id))).toMatchObject({ status: "closed", balance: 0n });
    }

    const payouts = await t.run(({ tx }) => tx.select().from(memberExitPayout).where(sql`${memberExitPayout.exitId} = ${exitId}`));
    expect(payouts.map((p) => [p.kind, p.amount]).sort()).toEqual(
      [["savings", 1000_00n], ["savings", 250_00n], ["shares", 500_00n]].sort(),
    );
    const shareEntry = await t.run((ctx) => getEntry(ctx, payouts.find((p) => p.kind === "shares")!.journalEntryId));
    expect(shareEntry.entry.source).toBe("member_exit");
    expect(shareEntry.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [t.accounts.share_capital, 500_00n, 0n],
      [t.accounts.cash_in_hand, 0n, 500_00n],
    ]);

    // Everything the member put in has gone back out.
    const tb = await t.run((ctx) => trialBalance(ctx, DATE));
    const net = (code: string) => {
      const r = tb.rows.find((x) => x.code === code);
      return (r?.debit ?? 0n) - (r?.credit ?? 0n);
    };
    expect([net("1100"), net("2100"), net("3100")]).toEqual([0n, 0n, 0n]);

    const [view] = await t.run((ctx) => memberExits(ctx, memberId));
    expect(view).toMatchObject({ status: "approved", shareRefund: 500_00n, savingsPayout: 1250_00n });
    expect(view!.entryNos).toHaveLength(3);
    const audit = await t.run(({ tx }) => tx.select({ action: auditLog.action }).from(auditLog).where(sql`${auditLog.action} like 'member.exit.%'`));
    expect(audit.map((a) => a.action).sort()).toEqual(["member.exit.approve", "member.exit.request"]);
  });

  it("pays out what is there at approval, including deposits made after the request", async () => {
    const t = await newTenant(DATE);
    const president = await addOfficer(t);
    const { memberId, accounts } = await settledMember(t);
    const exitId = await asked(t, memberId);
    await t.run((ctx) =>
      deposit(ctx, { accountId: accounts[0]!, amount: "100", method: "cash", idempotencyKey: randomUUID() }, { userId: t.adminUserId, channel: "office" }),
    );
    const r = await t.run((ctx) => approveExit(ctx, { exitId, userId: president }));
    expect(r.ok && r.settlement?.savingsPayout).toBe(1350_00n);
  });

  it("settles a member with nothing to pay out, without posting", async () => {
    const t = await newTenant(DATE);
    const president = await addOfficer(t);
    const m = await t.run((ctx) => admitMember(ctx, { nameEn: "Empty", phone: "01711111111" }, { userId: t.adminUserId }));
    if (!m.ok) throw new Error("admit failed");
    const exitId = await asked(t, m.member.id);
    const r = await t.run((ctx) => approveExit(ctx, { exitId, userId: president }));
    expect(r).toEqual({ ok: true, settlement: { shareRefund: 0n, savingsPayout: 0n, entryNos: [] } });
  });

  it("needs a second officer, and lets the requester only cancel", async () => {
    const t = await newTenant(DATE);
    const president = await addOfficer(t);
    const { memberId } = await settledMember(t);
    const exitId = await asked(t, memberId);
    expect(await t.run((ctx) => approveExit(ctx, { exitId, userId: t.adminUserId }))).toEqual({ ok: false, error: "self_decision" });
    expect(await t.run((ctx) => rejectExit(ctx, { exitId, userId: t.adminUserId, note: "no" }))).toEqual({ ok: false, error: "self_decision" });
    expect(await t.run((ctx) => cancelExit(ctx, { exitId, userId: president }))).toEqual({ ok: false, error: "not_maker" });
    expect(await t.run((ctx) => rejectExit(ctx, { exitId, userId: president, note: "  " }))).toEqual({ ok: false, error: "note_required" });
    expect(await t.run((ctx) => rejectExit(ctx, { exitId, userId: president, note: "Loan papers still open" }))).toEqual({ ok: true });
    expect(await t.run((ctx) => approveExit(ctx, { exitId, userId: president }))).toEqual({ ok: false, error: "decided" });

    const [m] = await t.run(({ tx }) => tx.select({ status: member.status }).from(member).where(sql`${member.id} = ${memberId}`));
    expect(m!.status).toBe("active");

    const again = await asked(t, memberId);
    expect(await t.run((ctx) => cancelExit(ctx, { exitId: again, userId: t.adminUserId }))).toEqual({ ok: true });
  });

  it("checks the form, keeps one request pending at a time, and replays a double submit", async () => {
    const t = await newTenant(DATE);
    const { memberId } = await settledMember(t);
    expect(await ask(t, { memberId, reason: " ", method: "cheque" })).toEqual({
      ok: false,
      errors: { reason: "reason_required", method: "invalid_method" },
    });
    expect(await ask(t, { memberId, method: "mobile_wallet" })).toEqual({ ok: false, errors: { paymentRef: "ref_required" } });
    const key = randomUUID();
    const first = await ask(t, { memberId, submitKey: key });
    expect(await ask(t, { memberId, submitKey: key })).toEqual(first.ok ? { ok: true, exitId: first.exitId, replayed: true } : {});
    expect(await ask(t, { memberId })).toEqual({ ok: false, errors: { form: "already_pending" } });
  });

  it("waits for pending withdrawals, and refuses members who have already left", async () => {
    const t = await newTenant(DATE);
    const president = await addOfficer(t);
    const { memberId, accounts } = await settledMember(t);
    const w = await t.run((ctx) =>
      requestWithdrawal(ctx, { accountId: accounts[0]!, amount: "100", method: "cash", submitKey: randomUUID() }, { userId: t.adminUserId }),
    );
    expect(w.ok).toBe(true);
    expect(await t.run((ctx) => exitBlockers(ctx, memberId))).toEqual(["pending_withdrawal"]);
    expect(await ask(t, { memberId })).toMatchObject({ ok: false, errors: { form: "pending_withdrawal" } });

    expect(await t.run((ctx) => approveExit(ctx, { exitId: "not-an-exit", userId: president }))).toEqual({ ok: false, error: "not_found" });
    const other = await t.run((ctx) => admitMember(ctx, { nameEn: "Gone", phone: "01722222222" }, { userId: t.adminUserId }));
    if (!other.ok) throw new Error("admit failed");
    await t.run(({ tx }) => tx.update(member).set({ status: "deceased" }).where(sql`${member.id} = ${other.member.id}`));
    expect(await ask(t, { memberId: other.member.id })).toMatchObject({ ok: false, errors: { form: "not_active" } });
  });
});

describe("the database itself", () => {
  const code = (c: string) => ({ cause: expect.objectContaining({ code: c }) });

  it("refuses an officer approving their own request, and any change after the decision", async () => {
    const t = await newTenant(DATE);
    const president = await addOfficer(t);
    const { memberId } = await settledMember(t);
    const exitId = await asked(t, memberId);
    await expect(
      t.run(({ tx }) =>
        tx.update(memberExit).set({ status: "rejected", decidedBy: t.adminUserId, decidedAt: sql`now()`, decisionNote: "x" }).where(sql`${memberExit.id} = ${exitId}`),
      ),
    ).rejects.toMatchObject(code("23514"));
    await t.run((ctx) => rejectExit(ctx, { exitId, userId: president, note: "not yet" }));
    // SM020 ("already decided") reaches the app as the ledger's VOUCHER_DECIDED error.
    await expect(
      t.run(({ tx }) => tx.update(memberExit).set({ decisionNote: "changed" }).where(sql`${memberExit.id} = ${exitId}`)),
    ).rejects.toMatchObject({ code: "VOUCHER_DECIDED" });
    await expect(t.run(({ tx }) => tx.execute(sql`delete from member_exit where id = ${exitId}`))).rejects.toMatchObject(code("42501"));
  });

  it("never reopens a closed savings account, and keeps exits to their somiti", async () => {
    const t = await newTenant(DATE);
    const other = await newTenant(DATE);
    const president = await addOfficer(t);
    const { memberId, accounts } = await settledMember(t);
    const exitId = await asked(t, memberId);
    await t.run((ctx) => approveExit(ctx, { exitId, userId: president }));
    await expect(
      t.run(({ tx }) => tx.update(savingsAccount).set({ status: "active" }).where(sql`${savingsAccount.id} = ${accounts[0]}`)),
    ).rejects.toMatchObject(code("SM009"));
    expect(await other.run((ctx) => memberExits(ctx, memberId))).toEqual([]);
  });
});
