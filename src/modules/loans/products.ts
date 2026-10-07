import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { loanProduct } from "@/db/schema";
import { toLatinDigits } from "@/lib/digits";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import { parsePercent } from "./percent";
import type { LoanFrequency, LoanMethod } from "./schedule";

export { parsePercent };

export const LOAN_METHODS = ["flat", "declining"] as const;
export const LOAN_FREQUENCIES = ["weekly", "monthly"] as const;
export const CHARGE_LABELS = ["service_charge", "interest"] as const;
export type ChargeLabel = (typeof CHARGE_LABELS)[number];
/** 10 crore taka: far above any somiti loan, low enough to catch a slipped digit. */
export const MAX_LOAN = 10_000_000_000n;
export const MAX_INSTALLMENTS = 520;

export interface LoanProductForm {
  code: string;
  nameEn: string;
  nameBn?: string;
  method: string;
  chargeLabel?: string;
  /** Yearly rate as typed, in percent: "12" or "12.5". */
  rate: string;
  frequency: string;
  minAmount: string;
  maxAmount: string;
  maxInstallments: string;
  /** Processing fee in percent of the principal; blank for none. */
  fee?: string;
}

export type LoanProductError =
  | "required"
  | "code_format"
  | "code_taken"
  | "too_long"
  | "invalid"
  | "invalid_rate"
  | "invalid_amount"
  | "too_large"
  | "max_below_min"
  | "invalid_installments"
  | "invalid_fee";

export type LoanProductErrors = Partial<Record<keyof LoanProductForm, LoanProductError>>;

export interface LoanProductView {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  method: LoanMethod;
  chargeLabel: ChargeLabel;
  rateBp: number;
  frequency: LoanFrequency;
  minAmount: bigint;
  maxAmount: bigint;
  maxInstallments: number;
  processingFeeBp: number;
  active: boolean;
  /** Loans paid out and not yet closed. */
  liveLoans: number;
  /** Principal paid out on those loans. */
  disbursed: bigint;
}

function amount(input: string): bigint | "required" | "invalid_amount" | "too_large" {
  if (!input.trim()) return "required";
  const paisa = parseTaka(input);
  if (paisa === null || paisa <= 0n) return "invalid_amount";
  return paisa > MAX_LOAN ? "too_large" : paisa;
}

export function checkLoanProductForm(form: LoanProductForm):
  | {
      ok: true;
      value: Omit<LoanProductView, "id" | "active" | "liveLoans" | "disbursed">;
    }
  | { ok: false; errors: LoanProductErrors } {
  const errors: LoanProductErrors = {};
  const code = form.code.trim().toUpperCase();
  if (!code) errors.code = "required";
  else if (!/^[A-Z0-9-]{1,12}$/.test(code)) errors.code = "code_format";
  const nameEn = form.nameEn.trim();
  if (!nameEn) errors.nameEn = "required";
  else if (nameEn.length > 80) errors.nameEn = "too_long";
  const nameBn = form.nameBn?.trim() || null;
  if (nameBn && nameBn.length > 80) errors.nameBn = "too_long";

  const method = LOAN_METHODS.find((m) => m === form.method);
  if (!method) errors.method = "invalid";
  const chargeLabel = CHARGE_LABELS.find((c) => c === (form.chargeLabel || "service_charge"));
  if (!chargeLabel) errors.chargeLabel = "invalid";
  const frequency = LOAN_FREQUENCIES.find((f) => f === form.frequency);
  if (!frequency) errors.frequency = "invalid";
  const rateBp = form.rate.trim() ? parsePercent(form.rate, 10_000) : null;
  if (!form.rate.trim()) errors.rate = "required";
  else if (rateBp === null) errors.rate = "invalid_rate";

  const min = amount(form.minAmount);
  const max = amount(form.maxAmount);
  if (typeof min === "string") errors.minAmount = min;
  if (typeof max === "string") errors.maxAmount = max;
  else if (typeof min === "bigint" && max < min) errors.maxAmount = "max_below_min";

  const n = /^\d{1,3}$/.test(toLatinDigits(form.maxInstallments.trim())) ? Number(toLatinDigits(form.maxInstallments.trim())) : NaN;
  if (!form.maxInstallments.trim()) errors.maxInstallments = "required";
  else if (!(n >= 1 && n <= MAX_INSTALLMENTS)) errors.maxInstallments = "invalid_installments";

  const fee = form.fee?.trim() ? parsePercent(form.fee, 1000) : 0;
  if (fee === null) errors.fee = "invalid_fee";

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      code,
      nameEn,
      nameBn,
      method: method!,
      chargeLabel: chargeLabel!,
      rateBp: rateBp!,
      frequency: frequency!,
      minAmount: min as bigint,
      maxAmount: max as bigint,
      maxInstallments: n,
      processingFeeBp: fee!,
    },
  };
}

export async function createLoanProduct(
  ctx: TenantTx,
  form: LoanProductForm,
  actor: { userId: string; device?: string },
): Promise<{ ok: true; id: string } | { ok: false; errors: LoanProductErrors }> {
  const checked = checkLoanProductForm(form);
  if (!checked.ok) return checked;
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .insert(loanProduct)
    .values({ tenantId, ...checked.value, createdBy: actor.userId })
    .onConflictDoNothing({ target: [loanProduct.tenantId, loanProduct.code] })
    .returning({ id: loanProduct.id });
  if (!row) return { ok: false, errors: { code: "code_taken" } };
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "loan.product.create",
    entityType: "loan_product",
    entityId: row.id,
    after: { ...checked.value, minAmount: checked.value.minAmount.toString(), maxAmount: checked.value.maxAmount.toString() },
    device: actor.device,
  });
  return { ok: true, id: row.id };
}

/** Switches a product on or off. Live loans carry on; no new applications while it is off. */
export async function setLoanProductActive(
  ctx: TenantTx,
  productId: string,
  active: boolean,
  actor: { userId: string; device?: string },
): Promise<boolean> {
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .update(loanProduct)
    .set({ active })
    .where(and(eq(loanProduct.tenantId, tenantId), eq(loanProduct.id, productId)))
    .returning({ id: loanProduct.id });
  if (!row) return false;
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: active ? "loan.product.activate" : "loan.product.deactivate",
    entityType: "loan_product",
    entityId: productId,
    after: { active },
    device: actor.device,
  });
  return true;
}

export async function listLoanProducts({ tx, tenantId }: TenantTx, opts: { activeOnly?: boolean } = {}): Promise<LoanProductView[]> {
  const rows = await tx
    .select({
      id: loanProduct.id,
      code: loanProduct.code,
      nameEn: loanProduct.nameEn,
      nameBn: loanProduct.nameBn,
      method: loanProduct.method,
      chargeLabel: loanProduct.chargeLabel,
      rateBp: loanProduct.rateBp,
      frequency: loanProduct.frequency,
      minAmount: loanProduct.minAmount,
      maxAmount: loanProduct.maxAmount,
      maxInstallments: loanProduct.maxInstallments,
      processingFeeBp: loanProduct.processingFeeBp,
      active: loanProduct.active,
      liveLoans: sql<number>`(select count(*)::int from loan l where l.tenant_id = ${loanProduct.tenantId} and l.product_id = ${loanProduct.id} and l.status = 'disbursed')`,
      disbursed: sql<string>`(select coalesce(sum(l.principal), 0) from loan l where l.tenant_id = ${loanProduct.tenantId} and l.product_id = ${loanProduct.id} and l.status = 'disbursed')`.mapWith(
        (v: string | number) => BigInt(v),
      ),
    })
    .from(loanProduct)
    .where(and(eq(loanProduct.tenantId, tenantId), opts.activeOnly ? eq(loanProduct.active, true) : undefined))
    .orderBy(asc(loanProduct.code));
  return rows as LoanProductView[];
}
