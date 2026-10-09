import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { idempotencyKey, loan, loanInstallment, member, tenant } from "@/db/schema";
import { parseCsv } from "@/lib/csv";
import { toLatinDigits } from "@/lib/digits";
import { parseTaka } from "@/lib/money";
import { normalizeBdPhone } from "@/lib/phone";
import { recordAudit } from "@/modules/audit/log";
import { accountIdsByKey, postEntry } from "@/modules/ledger";
import { ensureOpeningEquity } from "@/modules/opening/equity";
import { parseSheetDate } from "@/modules/opening/parse";
import { allocate, type Allocation } from "./allocate";
import { listLoanProducts, MAX_INSTALLMENTS, MAX_LOAN } from "./products";
import { buildSchedule, type LoanFrequency, type LoanMethod } from "./schedule";

/*
 * Bringing in loans that were already running on paper. Each row says how
 * the loan was given (member, product, date, amount, installments) and how
 * much has been repaid since. The app rebuilds the original schedule from
 * the product's terms, lets the repaid amount settle the oldest installments
 * first (as a repayment would), and keeps only what is still owed: those
 * installments, on their original due dates, become the loan's schedule.
 *
 * Only the principal still owed is posted (Dr Loans receivable, Cr Opening
 * balance equity); the charge still owed is income when it is paid, as for
 * any loan. Installments already past due count as late from the start.
 */

export const LOAN_IMPORT_COLUMNS = ["member_no", "phone", "product", "disbursed_on", "amount", "installments", "paid"] as const;
export const MAX_LOAN_IMPORT_ROWS = 2000;

export type LoanImportHeaderError =
  | { code: "empty_file" }
  | { code: "too_many_rows"; max: number }
  | { code: "missing_column"; column: string }
  | { code: "unknown_column"; column: string }
  | { code: "duplicate_column"; column: string };

export type LoanImportErrorCode =
  | "member_required"
  | "unknown_member"
  | "member_mismatch"
  | "member_inactive"
  | "unknown_product"
  | "inactive_product"
  | "invalid_date"
  | "date_after_business_date"
  | "invalid_amount"
  | "amount_too_large"
  | "invalid_installments"
  | "invalid_paid"
  | "already_repaid"
  | "only_charge_left"
  | "already_open"
  | "duplicate_loan"
  | "nothing_to_import";

export interface LoanImportRowError {
  /** Line in the file, counting the header as line 1, as Excel numbers rows. */
  line: number;
  column: string;
  code: LoanImportErrorCode;
}

export interface LoanImportRow {
  line: number;
  memberId: string;
  memberNo: number;
  nameEn: string | null;
  nameBn: string | null;
  branchId: string;
  productId: string;
  productCode: string;
  disbursedOn: string;
  amount: bigint;
  installments: number;
  paid: bigint;
  /** What is still owed, installment by installment, on the original due dates. */
  remaining: { seq: number; dueOn: string; principal: bigint; interest: bigint }[];
  principalLeft: bigint;
  chargeLeft: bigint;
  /** Remaining installments already past their due date on the business date. */
  overdue: number;
  nextDue: string;
  terms: { method: LoanMethod; rateBp: number; frequency: LoanFrequency; allocation: Allocation; lateFine: bigint | null; settlementRebateBp: number };
}

export interface LoanImportPreview {
  headerErrors: LoanImportHeaderError[];
  errors: LoanImportRowError[];
  rows: LoanImportRow[];
  totals: { loans: number; principalLeft: bigint; chargeLeft: bigint; overdueLoans: number };
}

const key = (h: string) => h.trim().toLowerCase().replace(/\s+/g, "_");

function sheetPhone(input: string): string | null {
  const digits = toLatinDigits(input).replace(/[\s\-().]/g, "");
  return normalizeBdPhone(/^1[3-9]\d{8}$/.test(digits) ? `0${digits}` : digits);
}

/** Checks a sheet of running loans against the somiti's members, products and open loans. Posts nothing. */
export async function previewLoanImport(ctx: TenantTx, csv: string): Promise<LoanImportPreview> {
  const { tx, tenantId } = ctx;
  const blank: LoanImportPreview = { headerErrors: [], errors: [], rows: [], totals: { loans: 0, principalLeft: 0n, chargeLeft: 0n, overdueLoans: 0 } };
  const lines = parseCsv(csv);
  const filled = lines.filter((r) => r.some((c) => c.trim() !== ""));
  if (filled.length < 2) return { ...blank, headerErrors: [{ code: "empty_file" }] };
  if (filled.length - 1 > MAX_LOAN_IMPORT_ROWS) return { ...blank, headerErrors: [{ code: "too_many_rows", max: MAX_LOAN_IMPORT_ROWS }] };

  const headerLine = lines.findIndex((r) => r.some((c) => c.trim() !== ""));
  const raw = lines[headerLine]!;
  const columns = new Map<string, number>();
  const headerErrors: LoanImportHeaderError[] = [];
  raw.forEach((h, i) => {
    const k = key(h);
    if (!k) return;
    if (columns.has(k)) headerErrors.push({ code: "duplicate_column", column: h.trim() });
    else if (!(LOAN_IMPORT_COLUMNS as readonly string[]).includes(k)) headerErrors.push({ code: "unknown_column", column: h.trim() });
    columns.set(k, i);
  });
  if (!columns.has("member_no") && !columns.has("phone")) headerErrors.push({ code: "missing_column", column: "member_no" });
  for (const c of ["product", "disbursed_on", "amount", "installments", "paid"]) if (!columns.has(c)) headerErrors.push({ code: "missing_column", column: c });
  if (headerErrors.length) return { ...blank, headerErrors };

  const [somiti] = await tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, tenantId));
  const businessDate = somiti!.businessDate;
  const products = new Map((await listLoanProducts(ctx)).map((p) => [p.code.toLowerCase(), p]));
  const members = await tx
    .select({ id: member.id, memberNo: member.memberNo, phone: member.phone, status: member.status, nameEn: member.nameEn, nameBn: member.nameBn, branchId: member.branchId })
    .from(member)
    .where(eq(member.tenantId, tenantId));
  const byNo = new Map(members.map((m) => [m.memberNo, m]));
  const byPhone = new Map(members.map((m) => [m.phone, m]));
  const open = await tx
    .select({ memberId: loan.memberId, productId: loan.productId })
    .from(loan)
    .where(and(eq(loan.tenantId, tenantId), inArray(loan.status, ["applied", "approved", "disbursed"])));
  const taken = new Set(open.map((o) => `${o.memberId}:${o.productId}`));
  const inSheet = new Set<string>();

  const errors: LoanImportRowError[] = [];
  const rows: LoanImportRow[] = [];
  const totals = { ...blank.totals };

  for (let n = headerLine + 1; n < lines.length; n++) {
    const cells = lines[n]!;
    if (!cells.some((c) => c.trim() !== "")) continue;
    const line = n + 1;
    const cell = (name: string) => {
      const i = columns.get(name);
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const before = errors.length;
    const fail = (column: string, code: LoanImportErrorCode) => errors.push({ line, column, code });

    // Member: by number, by phone, or both (then they must agree).
    const noText = toLatinDigits(cell("member_no")).replace(/^#/, "");
    const phoneText = cell("phone");
    let owner: (typeof members)[number] | undefined;
    if (!noText && !phoneText) fail("member_no", "member_required");
    else {
      const byNumber = noText ? (/^\d{1,7}$/.test(noText) ? byNo.get(Number(noText)) : undefined) : undefined;
      const phone = phoneText ? sheetPhone(phoneText) : null;
      const byMobile = phone ? byPhone.get(phone) : undefined;
      if (noText && !byNumber) fail("member_no", "unknown_member");
      else if (phoneText && !byMobile) fail("phone", "unknown_member");
      else if (byNumber && byMobile && byNumber.id !== byMobile.id) fail("phone", "member_mismatch");
      else {
        owner = byNumber ?? byMobile;
        if (owner && owner.status !== "active") fail(noText ? "member_no" : "phone", "member_inactive");
      }
    }

    const product = products.get(cell("product").toLowerCase());
    if (!product) fail("product", "unknown_product");
    else if (!product.active) fail("product", "inactive_product");

    const dateText = cell("disbursed_on");
    const disbursedOn = dateText ? parseSheetDate(dateText) : null;
    if (!disbursedOn) fail("disbursed_on", "invalid_date");
    else if (disbursedOn > businessDate) fail("disbursed_on", "date_after_business_date");

    const amount = parseTaka(cell("amount"));
    if (amount === null || amount <= 0n) fail("amount", "invalid_amount");
    else if (amount > MAX_LOAN) fail("amount", "amount_too_large");

    const nText = toLatinDigits(cell("installments"));
    const count = /^\d{1,3}$/.test(nText) ? Number(nText) : 0;
    if (!(count >= 1 && count <= MAX_INSTALLMENTS)) fail("installments", "invalid_installments");

    const paidText = cell("paid");
    const paid = paidText ? parseTaka(paidText) : 0n;
    if (paid === null || paid < 0n) fail("paid", "invalid_paid");

    if (errors.length > before) continue;

    const terms = {
      method: product!.method as LoanMethod,
      rateBp: product!.rateBp,
      frequency: product!.frequency as LoanFrequency,
      allocation: product!.allocation as Allocation,
      lateFine: product!.lateFine,
      settlementRebateBp: product!.settlementRebateBp,
    };
    const schedule = buildSchedule({ principal: amount!, method: terms.method, rateBp: terms.rateBp, frequency: terms.frequency, installments: count }, disbursedOn!);
    const total = schedule.reduce((s, r) => s + r.principal + r.interest, 0n);
    if (paid! >= total) {
      fail("paid", "already_repaid");
      continue;
    }
    const settled = new Map<number, { principal: bigint; interest: bigint }>();
    if (paid! > 0n) {
      const state = schedule.map((r) => ({ seq: r.seq, dueOn: r.dueOn, principal: r.principal, interest: r.interest, paidPrincipal: 0n, paidInterest: 0n }));
      for (const l of allocate(state, paid!, terms.allocation)!) settled.set(l.seq, l);
    }
    const remaining = schedule
      .map((r) => ({
        seq: r.seq,
        dueOn: r.dueOn,
        principal: r.principal - (settled.get(r.seq)?.principal ?? 0n),
        interest: r.interest - (settled.get(r.seq)?.interest ?? 0n),
      }))
      .filter((r) => r.principal + r.interest > 0n);
    const principalLeft = remaining.reduce((s, r) => s + r.principal, 0n);
    const chargeLeft = remaining.reduce((s, r) => s + r.interest, 0n);
    if (principalLeft === 0n) {
      fail("paid", "only_charge_left");
      continue;
    }

    const pair = `${owner!.id}:${product!.id}`;
    if (taken.has(pair)) {
      fail("product", "already_open");
      continue;
    }
    if (inSheet.has(pair)) {
      fail("product", "duplicate_loan");
      continue;
    }
    inSheet.add(pair);

    const overdue = remaining.filter((r) => r.dueOn < businessDate).length;
    rows.push({
      line,
      memberId: owner!.id,
      memberNo: owner!.memberNo,
      nameEn: owner!.nameEn,
      nameBn: owner!.nameBn,
      branchId: owner!.branchId,
      productId: product!.id,
      productCode: product!.code,
      disbursedOn: disbursedOn!,
      amount: amount!,
      installments: count,
      paid: paid!,
      remaining,
      principalLeft,
      chargeLeft,
      overdue,
      nextDue: remaining[0]!.dueOn,
      terms,
    });
    totals.loans++;
    totals.principalLeft += principalLeft;
    totals.chargeLeft += chargeLeft;
    if (overdue > 0) totals.overdueLoans++;
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: headerLine + 2, column: "", code: "nothing_to_import" });
  return { headerErrors, errors, rows, totals };
}

export type LoanImportError = "has_errors" | "already_used";

export interface LoanImportSummary {
  loans: number;
  principalLeft: bigint;
  chargeLeft: bigint;
  firstLoanNo: number | null;
  lastLoanNo: number | null;
  replayed: boolean;
}

export type LoanImportResult = { ok: true; summary: LoanImportSummary } | { ok: false; error: LoanImportError; preview?: LoanImportPreview };

/**
 * Imports every loan on the sheet in one transaction, or none: the sheet is
 * checked again here, and the batch key makes a double submit a no-op.
 */
export async function importLoans(ctx: TenantTx, input: { csv: string; batchKey: string }, actor: { userId: string; device?: string }): Promise<LoanImportResult> {
  const { tx, tenantId } = ctx;
  // Loan numbers are gap-free; take the same turn applications do before checking for open loans.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`loan_no:${tenantId}`}))`);
  const batch = `loan-import:${input.batchKey}`;
  const hash = createHash("sha256").update(input.csv).digest("hex");
  // A sheet already imported under this key is a double submit: its loans now count as open, so answer before checking it.
  const [prior] = await tx
    .select({ scope: idempotencyKey.scope, requestHash: idempotencyKey.requestHash })
    .from(idempotencyKey)
    .where(and(eq(idempotencyKey.tenantId, tenantId), eq(idempotencyKey.key, batch)));
  const preview = await previewLoanImport(ctx, input.csv);
  const summary: LoanImportSummary = {
    loans: preview.totals.loans,
    principalLeft: preview.totals.principalLeft,
    chargeLeft: preview.totals.chargeLeft,
    firstLoanNo: null,
    lastLoanNo: null,
    replayed: false,
  };
  if (prior) {
    if (prior.scope !== "loan_import" || prior.requestHash !== hash) return { ok: false, error: "already_used" };
    return { ok: true, summary: { ...summary, replayed: true } };
  }
  if (preview.headerErrors.length || preview.errors.length) return { ok: false, error: "has_errors", preview };
  await tx.insert(idempotencyKey).values({ tenantId, key: batch, scope: "loan_import", requestHash: hash, resultId: randomUUID() });

  await ensureOpeningEquity(ctx);
  const acc = await accountIdsByKey(ctx, ["loans_receivable", "opening_balance_equity"] as const);
  const [last] = await tx.select({ n: sql<number>`coalesce(max(${loan.loanNo}), 0)` }).from(loan).where(eq(loan.tenantId, tenantId));
  let loanNo = Number(last?.n ?? 0);

  for (const r of preview.rows) {
    loanNo++;
    const posted = await postEntry(ctx, {
      branchId: r.branchId,
      source: "opening_balance",
      narration: `Opening loan balance: ${r.productCode} loan #${loanNo}, member #${r.memberNo}, given ${r.disbursedOn}`,
      createdBy: actor.userId,
      device: actor.device,
      lines: [
        { accountId: acc.loans_receivable, debit: r.principalLeft, memberId: r.memberId },
        { accountId: acc.opening_balance_equity, credit: r.principalLeft },
      ],
    });
    const [row] = await tx
      .insert(loan)
      .values({
        tenantId,
        loanNo,
        memberId: r.memberId,
        productId: r.productId,
        principal: r.principalLeft,
        method: r.terms.method,
        rateBp: r.terms.rateBp,
        frequency: r.terms.frequency,
        installments: r.remaining.length,
        processingFee: 0n,
        allocation: r.terms.allocation,
        lateFine: r.terms.lateFine,
        settlementRebateBp: r.terms.settlementRebateBp,
        status: "disbursed",
        appliedBy: actor.userId,
        appliedOn: r.disbursedOn,
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionNote: "Imported from the paper books",
        disbursedBy: actor.userId,
        disbursedOn: r.disbursedOn,
        entryId: posted.entry.id,
        importedOn: posted.entry.businessDate,
        originalPrincipal: r.amount,
        originalInstallments: r.installments,
        paidBefore: r.paid,
      })
      .returning({ id: loan.id });
    await tx.insert(loanInstallment).values(r.remaining.map((i) => ({ tenantId, loanId: row!.id, ...i })));
    summary.firstLoanNo ??= loanNo;
    summary.lastLoanNo = loanNo;
  }

  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "loan.import",
    entityType: "tenant",
    entityId: tenantId,
    after: {
      batch: input.batchKey,
      loans: summary.loans,
      loanNos: [summary.firstLoanNo, summary.lastLoanNo],
      principalLeft: summary.principalLeft.toString(),
      chargeLeft: summary.chargeLeft.toString(),
    },
    device: actor.device,
  });
  return { ok: true, summary };
}

/** The blank sheet to download. */
export function loanImportTemplate(): string[][] {
  return [[...LOAN_IMPORT_COLUMNS]];
}
