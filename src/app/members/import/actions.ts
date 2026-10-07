"use server";

import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import {
  canImportOpening,
  importOpening,
  previewOpening,
  type OpeningHeaderError,
  type OpeningImportError,
  type OpeningRowError,
  type OpeningSheetPreview,
} from "@/modules/opening";
import { getCurrentUser } from "../../auth";

/** 1 MB holds a few thousand members; anything bigger is not the sheet we asked for. */
const MAX_SHEET_BYTES = 1_000_000;
const SHOWN_ROWS = 200;
const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD"]);

/** The preview as the browser gets it: money as paisa strings. */
export interface SheetPreview {
  headerErrors: OpeningHeaderError[];
  errors: OpeningRowError[];
  rows: { line: number; nameEn: string | null; nameBn: string | null; phone: string; admissionDate: string | null; shares: number; balances: Record<string, string> }[];
  rowCount: number;
  productCodes: string[];
  existingPhones: { line: number; memberNo: number }[];
  totals: { members: number; shares: number; shareAmount: string; savings: Record<string, { accounts: number; amount: string }>; savingsAmount: string };
}

export interface PreviewState {
  error?: "forbidden" | "no_file" | "too_big" | "not_csv" | "server";
  fileName?: string;
  csv?: string;
  batchKey?: string;
  preview?: SheetPreview;
  attempt?: number;
}

export interface ImportState {
  error?: OpeningImportError | "forbidden" | "server" | LedgerErrorCode;
  attempt?: number;
}

function forBrowser(p: OpeningSheetPreview): SheetPreview {
  return {
    headerErrors: p.headerErrors,
    errors: p.errors.slice(0, SHOWN_ROWS),
    rows: p.rows.slice(0, SHOWN_ROWS).map((r) => ({ ...r, balances: Object.fromEntries(Object.entries(r.balances).map(([k, v]) => [k, v.toString()])) })),
    rowCount: p.rows.length,
    productCodes: p.productCodes,
    existingPhones: p.existingPhones,
    totals: {
      ...p.totals,
      shareAmount: p.totals.shareAmount.toString(),
      savings: Object.fromEntries(Object.entries(p.totals.savings).map(([k, v]) => [k, { accounts: v.accounts, amount: v.amount.toString() }])),
      savingsAmount: p.totals.savingsAmount.toString(),
    },
  };
}

export async function previewSheetAction(prev: PreviewState, form: FormData): Promise<PreviewState> {
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
    const preview = await withTenant(getAppDb(), user.tenantId, (ctx) => previewOpening(ctx, csv));
    return { fileName: file.name, csv, batchKey: randomUUID(), preview: forBrowser(preview), attempt };
  } catch (err) {
    console.error(err);
    return { error: "server", attempt };
  }
}

export async function importSheetAction(prev: ImportState, form: FormData): Promise<ImportState> {
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
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      importOpening(
        ctx,
        { csv, cash: String(form.get("cash") ?? ""), bank: String(form.get("bank") ?? ""), batchKey },
        { userId: user.userId, device },
      ),
    );
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { error: err.code, attempt };
    console.error(err);
    return { error: "server", attempt };
  }
  if (!result.ok) return { error: result.error, attempt };
  revalidatePath("/", "layout");
  const s = result.summary;
  redirect(`/members?imported=${s.members}${s.firstMemberNo ? `&from=${s.firstMemberNo}&to=${s.lastMemberNo}` : ""}`);
}
