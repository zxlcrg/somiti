import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { idempotencyKey, journalEntry, journalLine, ledgerAccount, tenant } from "@/db/schema";
import { recordAudit } from "@/modules/audit/log";
import { LedgerError } from "./errors";
import {
  postEntryInput,
  reverseEntryInput,
  type PostEntryInput,
  type ReverseEntryInput,
} from "./validation";

/**
 * The ledger posting service. It is the only code that writes journal
 * tables. Every money event in every module ends up as one call to
 * postEntry (or reverseEntry) inside the caller's transaction.
 *
 * The database enforces the same rules independently (balance, append-only,
 * period lock, postable accounts), so a bug here cannot corrupt the books.
 */

export type EntryRow = typeof journalEntry.$inferSelect;
export type LineRow = typeof journalLine.$inferSelect;

export interface PostedEntry {
  entry: EntryRow;
  lines: LineRow[];
  /** True when an idempotency key matched an earlier request and nothing new was posted. */
  replayed: boolean;
}

const POST_SCOPE = "ledger.post";
const REVERSE_SCOPE = "ledger.reverse";

/** Hash of the request body. The key itself and the device are left out, so a re-sync from another device still matches. */
function requestHash(scope: string, body: unknown): string {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return createHash("sha256").update(scope).update("\0").update(json).digest("hex");
}

/**
 * Claims an idempotency key for `resultId`. Returns the id of an earlier
 * result when the key was already used for the same request, and throws
 * when it was used for a different one. A concurrent request with the same
 * key waits here until the first one commits or rolls back.
 */
async function claimKey(
  ctx: TenantTx,
  key: string,
  scope: string,
  hash: string,
  resultId: string,
): Promise<string | null> {
  const claimed = await ctx.tx
    .insert(idempotencyKey)
    .values({ tenantId: ctx.tenantId, key, scope, requestHash: hash, resultId })
    .onConflictDoNothing()
    .returning({ resultId: idempotencyKey.resultId });
  if (claimed.length > 0) return null;

  const [prior] = await ctx.tx
    .select()
    .from(idempotencyKey)
    .where(and(eq(idempotencyKey.tenantId, ctx.tenantId), eq(idempotencyKey.key, key)));
  if (!prior || prior.scope !== scope || prior.requestHash !== hash) {
    throw new LedgerError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for a different request",
    );
  }
  return prior.resultId;
}

async function currentBusinessDate(ctx: TenantTx): Promise<string> {
  const [row] = await ctx.tx
    .select({ businessDate: tenant.businessDate })
    .from(tenant)
    .where(eq(tenant.id, ctx.tenantId));
  if (!row) throw new LedgerError("UNKNOWN_TENANT", "Tenant not found");
  return row.businessDate;
}

/**
 * Gapless voucher numbers. The counter row is locked until the posting
 * commits, so postings within one somiti are serialised; that is fine at
 * one-somiti volumes and keeps numbering audit-friendly.
 */
async function nextEntryNo(ctx: TenantTx): Promise<bigint> {
  const result = await ctx.tx.execute<{ last_no: string }>(sql`
    insert into entry_counter (tenant_id, last_no) values (${ctx.tenantId}, 1)
    on conflict (tenant_id) do update set last_no = entry_counter.last_no + 1
    returning last_no`);
  return BigInt(result.rows[0]!.last_no);
}

export async function getEntry(ctx: TenantTx, entryId: string): Promise<Omit<PostedEntry, "replayed">> {
  const [entry] = await ctx.tx
    .select()
    .from(journalEntry)
    .where(and(eq(journalEntry.tenantId, ctx.tenantId), eq(journalEntry.id, entryId)));
  if (!entry) throw new LedgerError("NOT_FOUND", "Journal entry not found");
  const lines = await ctx.tx
    .select()
    .from(journalLine)
    .where(and(eq(journalLine.tenantId, ctx.tenantId), eq(journalLine.entryId, entryId)))
    .orderBy(asc(journalLine.lineNo));
  return { entry, lines };
}

async function assertPostable(ctx: TenantTx, accountIds: string[]): Promise<void> {
  const unique = [...new Set(accountIds)];
  const found = await ctx.tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(
      and(
        eq(ledgerAccount.tenantId, ctx.tenantId),
        inArray(ledgerAccount.id, unique),
        eq(ledgerAccount.isPostable, true),
        eq(ledgerAccount.isActive, true),
      ),
    );
  if (found.length !== unique.length) {
    const ok = new Set(found.map((a) => a.id));
    const bad = unique.filter((id) => !ok.has(id));
    throw new LedgerError("ACCOUNT_NOT_POSTABLE", `Not an active postable account: ${bad.join(", ")}`);
  }
}

interface InsertEntry {
  id: string;
  branchId: string;
  businessDate: string;
  source: EntryRow["source"];
  narration: string;
  reversesId?: string;
  createdBy: string;
  lines: Array<{
    accountId: string;
    debit?: bigint;
    credit?: bigint;
    memberId?: string | null;
    savingsAccountId?: string | null;
    loanId?: string | null;
    memo?: string | null;
  }>;
}

async function insertEntry(ctx: TenantTx, e: InsertEntry): Promise<Omit<PostedEntry, "replayed">> {
  const entryNo = await nextEntryNo(ctx);
  const [entry] = await ctx.tx
    .insert(journalEntry)
    .values({
      id: e.id,
      tenantId: ctx.tenantId,
      branchId: e.branchId,
      entryNo,
      businessDate: e.businessDate,
      source: e.source,
      narration: e.narration,
      reversesId: e.reversesId,
      createdBy: e.createdBy,
    })
    .returning();
  const lines = await ctx.tx
    .insert(journalLine)
    .values(
      e.lines.map((l, i) => ({
        tenantId: ctx.tenantId,
        entryId: e.id,
        lineNo: i + 1,
        accountId: l.accountId,
        debit: l.debit ?? 0n,
        credit: l.credit ?? 0n,
        memberId: l.memberId ?? null,
        savingsAccountId: l.savingsAccountId ?? null,
        loanId: l.loanId ?? null,
        memo: l.memo ?? null,
      })),
    )
    .returning();
  return { entry: entry!, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
}

/** Posts one balanced journal entry. */
export async function postEntry(ctx: TenantTx, raw: PostEntryInput): Promise<PostedEntry> {
  const parsed = postEntryInput.safeParse(raw);
  if (!parsed.success) {
    const unbalanced = parsed.error.issues.every((i) => i.message === "Debits must equal credits");
    throw new LedgerError(unbalanced ? "UNBALANCED" : "INVALID_INPUT", parsed.error.message, {
      cause: parsed.error,
    });
  }
  const input = parsed.data;
  const id = randomUUID();

  if (input.idempotencyKey) {
    const hash = requestHash(POST_SCOPE, { ...input, idempotencyKey: undefined, device: undefined });
    const prior = await claimKey(ctx, input.idempotencyKey, POST_SCOPE, hash, id);
    if (prior) return { ...(await getEntry(ctx, prior)), replayed: true };
  }

  await assertPostable(
    ctx,
    input.lines.map((l) => l.accountId),
  );
  const posted = await insertEntry(ctx, {
    id,
    branchId: input.branchId,
    businessDate: input.businessDate ?? (await currentBusinessDate(ctx)),
    source: input.source,
    narration: input.narration,
    createdBy: input.createdBy,
    lines: input.lines,
  });

  await recordAudit(ctx, {
    actorUserId: input.createdBy,
    action: "ledger.post",
    entityType: "journal_entry",
    entityId: id,
    after: summarise(posted),
    device: input.device,
  });
  return { ...posted, replayed: false };
}

/**
 * Cancels an entry by posting its mirror image (debits and credits swapped)
 * on the current business date. The original stays untouched.
 */
export async function reverseEntry(ctx: TenantTx, raw: ReverseEntryInput): Promise<PostedEntry> {
  const parsed = reverseEntryInput.safeParse(raw);
  if (!parsed.success) {
    throw new LedgerError("INVALID_INPUT", parsed.error.message, { cause: parsed.error });
  }
  const input = parsed.data;
  const id = randomUUID();

  if (input.idempotencyKey) {
    const hash = requestHash(REVERSE_SCOPE, { ...input, idempotencyKey: undefined, device: undefined });
    const prior = await claimKey(ctx, input.idempotencyKey, REVERSE_SCOPE, hash, id);
    if (prior) return { ...(await getEntry(ctx, prior)), replayed: true };
  }

  const original = await getEntry(ctx, input.entryId);
  if (original.entry.source === "reversal") {
    throw new LedgerError(
      "CANNOT_REVERSE_REVERSAL",
      "A reversal cannot itself be reversed; post a new entry instead",
    );
  }
  const [existing] = await ctx.tx
    .select({ id: journalEntry.id })
    .from(journalEntry)
    .where(and(eq(journalEntry.tenantId, ctx.tenantId), eq(journalEntry.reversesId, input.entryId)));
  if (existing) throw new LedgerError("ALREADY_REVERSED", "This entry has already been reversed");

  const posted = await insertEntry(ctx, {
    id,
    branchId: original.entry.branchId,
    businessDate: input.businessDate ?? (await currentBusinessDate(ctx)),
    source: "reversal",
    narration: input.reason,
    reversesId: original.entry.id,
    createdBy: input.createdBy,
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit > 0n ? l.credit : undefined,
      credit: l.debit > 0n ? l.debit : undefined,
      memberId: l.memberId,
      savingsAccountId: l.savingsAccountId,
      loanId: l.loanId,
      memo: l.memo,
    })),
  });

  await recordAudit(ctx, {
    actorUserId: input.createdBy,
    action: "ledger.reverse",
    entityType: "journal_entry",
    entityId: id,
    after: { ...summarise(posted), reversesEntryNo: original.entry.entryNo },
    device: input.device,
  });
  return { ...posted, replayed: false };
}

function summarise({ entry, lines }: Omit<PostedEntry, "replayed">) {
  return {
    entryNo: entry.entryNo,
    businessDate: entry.businessDate,
    source: entry.source,
    narration: entry.narration,
    total: lines.reduce((sum, l) => sum + l.debit, 0n),
    lines: lines.length,
  };
}
