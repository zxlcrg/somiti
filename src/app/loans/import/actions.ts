"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import {
  importLoans,
  previewLoanImport,
  type LoanImportError,
  type LoanImportHeaderError,
  type LoanImportPreview,
  type LoanImportRowError,
} from "@/modules/loans";
import { canImportOpening } from "@/modules/opening";
import { getCurrentUser } from "../../auth";

const MAX_SHEET_BYTES = 1_000_000;
const SHOWN_ROWS = 200;
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD"]);

/** The preview as the browser gets it: money as paisa strings. */
export interface LoanSheetPreview {
  headerErrors: LoanImportHeaderError[];
  errors: LoanImportRowError[];
  rows: {
    line: number;
    memberNo: number;
    nameEn: string | null;
    nameBn: string | null;
    productCode: string;
    disbursedOn: string;
    amount: string;
    installments: number;
    paid: string;
    principalLeft: string;
    chargeLeft: string;
    left: number;
    firstSeq: number;
    overdue: number;
    nextDue: string;
  }[];
  rowCount: number;
  totals: { loans: number; principalLeft: string; chargeLeft: string; overdueLoans: number };
}

export interface PreviewState {
  error?: "forbidden" | "no_file" | "too_big" | "not_csv" | "server";
  fileName?: string;
  csv?: string;
  batchKey?: string;
  preview?: LoanSheetPreview;
  attempt?: number;
}

export interface ImportState {
  error?: LoanImportError | "forbidden" | "server" | LedgerErrorCode;
  attempt?: number;
}

function forBrowser(p: LoanImportPreview): LoanSheetPreview {
  return {
    headerErrors: p.headerErrors,
    errors: p.errors.slice(0, SHOWN_ROWS),
    rows: p.rows.slice(0, SHOWN_ROWS).map((r) => ({
      line: r.line,
      memberNo: r.memberNo,
      nameEn: r.nameEn,
      nameBn: r.nameBn,
      productCode: r.productCode,
      disbursedOn: r.disbursedOn,
      amount: r.amount.toString(),
      installments: r.installments,
      paid: r.paid.toString(),
      principalLeft: r.principalLeft.toString(),
      chargeLeft: r.chargeLeft.toString(),
      left: r.remaining.length,
      firstSeq: r.remaining[0]!.seq,
      overdue: r.overdue,
      nextDue: r.nextDue,
    })),
    rowCount: p.rows.length,
    totals: { ...p.totals, principalLeft: p.totals.principalLeft.toString(), chargeLeft: p.totals.chargeLeft.toString() },
  };
}

export async function previewLoansAction(prev: PreviewState, form: FormData): Promise<PreviewState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canImportOpening(user.roles)) return { error: "forbidden", attempt };
  const file = form.get("sheet");
  if (!(file instanceof File) || file.size === 0) return { error: "no_file", attempt };
  if (file.size > MAX_SHEET_BYTES) return { error: "too_big", fileName: file.name, attempt };
  if (!/\.csv$/i.test(file.name) && !/csv|text\/plain/.test(file.type)) return { error: "not_csv", fileName: file.name, attempt };
  const csv = await file.text();
  try {
    const preview = await withTenant(getAppDb(), user.tenantId, (ctx) => previewLoanImport(ctx, csv));
    return { fileName: file.name, csv, batchKey: randomUUID(), preview: forBrowser(preview), attempt };
  } catch (err) {
    console.error(err);
    return { error: "server", attempt };
  }
}

export async function importLoansAction(prev: ImportState, form: FormData): Promise<ImportState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (!canImportOpening(user.roles)) return { error: "forbidden", attempt };
  const csv = String(form.get("csv") ?? "");
  const batchKey = String(form.get("batchKey") ?? "");
  if (csv.length > MAX_SHEET_BYTES || !/^[0-9a-f-]{36}$/.test(batchKey)) return { error: "has_errors", attempt };

  let result;
  try {
    const device = (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
    result = await withTenant(getAppDb(), user.tenantId, (ctx) => importLoans(ctx, { csv, batchKey }, { userId: user.userId, device }));
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { error: err.code, attempt };
    console.error(err);
    return { error: "server", attempt };
  }
  if (!result.ok) return { error: result.error, attempt };
  revalidatePath("/", "layout");
  const s = result.summary;
  redirect(s.replayed || !s.firstLoanNo ? "/loans" : `/loans?imported=${s.loans}&from=${s.firstLoanNo}&to=${s.lastLoanNo}`);
}
