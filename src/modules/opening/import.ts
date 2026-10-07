import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { branch, idempotencyKey, ledgerAccount, member, savingsTransaction, shareTransaction, tenant } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, DEFAULT_CHART, postEntry } from "@/modules/ledger";
import { admitMember } from "@/modules/members/service";
import { sharePrice } from "@/modules/members/shares";
import { openAccount } from "@/modules/savings/accounts";
import { listProducts } from "@/modules/savings/products";
import { MAX_OPENING_AMOUNT, parseOpeningSheet, type OpeningPreview } from "./parse";

/** Setting up the books is the admin's job, done once when the somiti starts using the app. */
export function canImportOpening(roles: readonly string[]): boolean {
  return roles.includes("admin");
}

export interface OpeningSheetPreview extends OpeningPreview {
  /** Lines whose phone already belongs to a member: likely the same sheet uploaded twice. */
  existingPhones: { line: number; memberNo: number }[];
  sharePrice: bigint;
}

async function sheetContext(ctx: TenantTx) {
  const [somiti] = await ctx.tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
  const products = await listProducts(ctx);
  return { businessDate: somiti!.businessDate, products, sharePrice: await sharePrice(ctx) };
}

/** Checks an uploaded sheet against the somiti's products and members. Posts nothing. */
export async function previewOpening(ctx: TenantTx, csv: string): Promise<OpeningSheetPreview> {
  const sheet = await sheetContext(ctx);
  const preview = parseOpeningSheet(csv, sheet);
  const phones = [...new Set(preview.rows.map((r) => r.phone))];
  const known = phones.length
    ? await ctx.tx
        .select({ phone: member.phone, memberNo: member.memberNo })
        .from(member)
        .where(and(eq(member.tenantId, ctx.tenantId), inArray(member.phone, phones)))
    : [];
  const byPhone = new Map(known.map((k) => [k.phone, k.memberNo]));
  const existingPhones = preview.rows.flatMap((r) => (byPhone.has(r.phone) ? [{ line: r.line, memberNo: byPhone.get(r.phone)! }] : []));
  return { ...preview, existingPhones, sharePrice: sheet.sharePrice };
}

/** Somitis created before the import existed lack account 3900; add it from the default chart. */
async function ensureOpeningEquity(ctx: TenantTx): Promise<void> {
  const spec = DEFAULT_CHART.find((a) => a.systemKey === "opening_balance_equity")!;
  const [parent] = await ctx.tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, ctx.tenantId), eq(ledgerAccount.code, spec.parent!)));
  await ctx.tx
    .insert(ledgerAccount)
    .values({
      tenantId: ctx.tenantId,
      code: spec.code,
      nameEn: spec.nameEn,
      nameBn: spec.nameBn,
      type: spec.type,
      parentId: parent?.id ?? null,
      systemKey: spec.systemKey,
    })
    .onConflictDoNothing();
}

export type OpeningImportError = "has_errors" | "invalid_cash" | "invalid_bank" | "already_used";

export interface OpeningImportSummary {
  members: number;
  shares: number;
  accounts: number;
  /** Everything credited to members plus cash and bank brought in. */
  shareAmount: bigint;
  savingsAmount: bigint;
  cash: bigint;
  bank: bigint;
  firstMemberNo: number | null;
  lastMemberNo: number | null;
  replayed: boolean;
}

export type OpeningImportResult =
  | { ok: true; summary: OpeningImportSummary }
  | { ok: false; error: OpeningImportError; preview?: OpeningSheetPreview };

function optionalMoney(text: string | undefined): bigint | null | "invalid" {
  if (!text?.trim()) return 0n;
  const paisa = parseTaka(text);
  return paisa === null || paisa < 0n || paisa > MAX_OPENING_AMOUNT ? "invalid" : paisa;
}

/**
 * Brings a somiti's existing books into the app in one transaction: admits
 * every member on the sheet, opens their savings accounts and records each
 * share holding and savings balance against Opening balance equity (3900),
 * along with the cash in hand and at the bank. Whatever is left in 3900 is
 * the accountant's to move to reserves or surplus. The sheet is checked
 * again here, so nothing is posted unless every row is clean; the batch key
 * makes a double submit a no-op.
 */
export async function importOpening(
  ctx: TenantTx,
  input: { csv: string; cash?: string; bank?: string; batchKey: string },
  actor: { userId: string; device?: string },
): Promise<OpeningImportResult> {
  const cash = optionalMoney(input.cash);
  if (cash === "invalid" || cash === null) return { ok: false, error: "invalid_cash" };
  const bank = optionalMoney(input.bank);
  if (bank === "invalid" || bank === null) return { ok: false, error: "invalid_bank" };

  const preview = await previewOpening(ctx, input.csv);
  if (preview.headerErrors.length || preview.errors.length) return { ok: false, error: "has_errors", preview };

  const summary: OpeningImportSummary = {
    members: preview.totals.members,
    shares: preview.totals.shares,
    accounts: Object.values(preview.totals.savings).reduce((s, p) => s + p.accounts, 0),
    shareAmount: preview.totals.shareAmount,
    savingsAmount: preview.totals.savingsAmount,
    cash,
    bank,
    firstMemberNo: null,
    lastMemberNo: null,
    replayed: false,
  };

  const { tx, tenantId } = ctx;
  const hash = createHash("sha256").update(input.csv).update("\0").update(`${cash}|${bank}`).digest("hex");
  const claimed = await tx
    .insert(idempotencyKey)
    .values({ tenantId, key: `opening-import:${input.batchKey}`, scope: "opening_import", requestHash: hash, resultId: randomUUID() })
    .onConflictDoNothing()
    .returning({ resultId: idempotencyKey.resultId });
  if (claimed.length === 0) {
    const [prior] = await tx
      .select({ scope: idempotencyKey.scope, requestHash: idempotencyKey.requestHash })
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.tenantId, tenantId), eq(idempotencyKey.key, `opening-import:${input.batchKey}`)));
    if (prior?.scope !== "opening_import" || prior.requestHash !== hash) return { ok: false, error: "already_used" };
    return { ok: true, summary: { ...summary, replayed: true } };
  }

  await ensureOpeningEquity(ctx);
  const acc = await accountIdsByKey(ctx, ["opening_balance_equity", "share_capital", "member_savings", "cash_in_hand", "bank"] as const);
  const productId = new Map(
    (await listProducts(ctx)).map((p) => [p.code, p.id]),
  );

  for (const row of preview.rows) {
    const admitted = await admitMember(
      ctx,
      { nameEn: row.nameEn ?? undefined, nameBn: row.nameBn ?? undefined, phone: row.phone, admissionDate: row.admissionDate ?? undefined },
      actor,
    );
    if (!admitted.ok) throw new Error(`Opening import: line ${row.line} failed admission after a clean check`);
    const m = admitted.member;
    summary.firstMemberNo ??= m.memberNo;
    summary.lastMemberNo = m.memberNo;

    if (row.shares > 0) {
      const amount = BigInt(row.shares) * preview.sharePrice;
      const posted = await postEntry(ctx, {
        branchId: m.branchId,
        source: "opening_balance",
        narration: `Opening shares: ${row.shares} × ${preview.sharePrice / 100n} taka, member #${m.memberNo}`,
        createdBy: actor.userId,
        device: actor.device,
        lines: [
          { accountId: acc.opening_balance_equity, debit: amount },
          { accountId: acc.share_capital, credit: amount, memberId: m.id },
        ],
      });
      await tx.insert(shareTransaction).values({
        tenantId,
        memberId: m.id,
        kind: "opening",
        shares: row.shares,
        price: preview.sharePrice,
        amount,
        paymentMethod: null,
        journalEntryId: posted.entry.id,
        businessDate: posted.entry.businessDate,
        createdBy: actor.userId,
      });
    }

    for (const [code, amount] of Object.entries(row.balances)) {
      const opened = await openAccount(ctx, { memberId: m.id, productId: productId.get(code)! }, actor);
      if (!opened.ok) throw new Error(`Opening import: line ${row.line} could not open ${code}`);
      if (amount === 0n) continue;
      const posted = await postEntry(ctx, {
        branchId: m.branchId,
        source: "opening_balance",
        narration: `Opening savings balance, ${code} account #${opened.accountNo}, member #${m.memberNo}`,
        createdBy: actor.userId,
        device: actor.device,
        lines: [
          { accountId: acc.opening_balance_equity, debit: amount },
          { accountId: acc.member_savings, credit: amount, memberId: m.id },
        ],
      });
      await tx.insert(savingsTransaction).values({
        tenantId,
        accountId: opened.accountId,
        kind: "opening",
        amount,
        channel: "office",
        paymentMethod: null,
        journalEntryId: posted.entry.id,
        businessDate: posted.entry.businessDate,
        createdBy: actor.userId,
      });
    }
  }

  if (cash > 0n || bank > 0n) {
    const [main] = await tx.select({ id: branch.id }).from(branch).where(eq(branch.tenantId, tenantId)).orderBy(asc(branch.createdAt)).limit(1);
    await postEntry(ctx, {
      branchId: main!.id,
      source: "opening_balance",
      narration: "Opening cash and bank balances",
      createdBy: actor.userId,
      device: actor.device,
      lines: [
        ...(cash > 0n ? [{ accountId: acc.cash_in_hand, debit: cash }] : []),
        ...(bank > 0n ? [{ accountId: acc.bank, debit: bank }] : []),
        { accountId: acc.opening_balance_equity, credit: cash + bank },
      ],
    });
  }

  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "opening.import",
    entityType: "tenant",
    entityId: tenantId,
    after: {
      batch: input.batchKey,
      members: summary.members,
      memberNos: [summary.firstMemberNo, summary.lastMemberNo],
      shares: summary.shares,
      accounts: summary.accounts,
      shareAmount: summary.shareAmount.toString(),
      savingsAmount: summary.savingsAmount.toString(),
      cash: cash.toString(),
      bank: bank.toString(),
    },
    device: actor.device,
  });
  return { ok: true, summary };
}
