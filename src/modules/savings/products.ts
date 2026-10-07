import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "@/db/client";
import { savingsProduct } from "@/db/schema";
import { parseTaka } from "@/lib/money";
import { recordAudit } from "@/modules/audit/log";
import type { SavingsFrequency } from "./schedule";

export const SAVINGS_FREQUENCIES = ["daily", "weekly", "monthly", "flexible"] as const;
/** ৳1,00,000 per installment is far above any somiti's daily or monthly savings. */
const MAX_INSTALLMENT = 1_00_000_00n;

export interface ProductForm {
  code: string;
  nameEn: string;
  nameBn?: string;
  frequency: string;
  /** Typed taka; Bangla digits are fine. Ignored for flexible products. */
  installment?: string;
  minDeposit?: string;
}

export type ProductErrorCode =
  | "required"
  | "code_format"
  | "code_taken"
  | "too_long"
  | "invalid_frequency"
  | "invalid_amount"
  | "too_large";

export type ProductErrors = Partial<Record<"code" | "nameEn" | "nameBn" | "frequency" | "installment" | "minDeposit", ProductErrorCode>>;

export interface SavingsProductView {
  id: string;
  code: string;
  nameEn: string;
  nameBn: string | null;
  frequency: SavingsFrequency;
  installment: bigint | null;
  minDeposit: bigint;
  active: boolean;
  openAccounts: number;
  /** Sum of the open accounts' deposits that still count. */
  balance: bigint;
}

function money(input: string | undefined): bigint | null | "invalid" | "too_large" {
  const text = input?.trim();
  if (!text) return null;
  const paisa = parseTaka(text);
  if (paisa === null || paisa <= 0n) return "invalid";
  return paisa > MAX_INSTALLMENT ? "too_large" : paisa;
}

/** Checks a new product's form; returns the clean values or the errors by field. */
export function checkProductForm(form: ProductForm):
  | { ok: true; value: { code: string; nameEn: string; nameBn: string | null; frequency: SavingsFrequency; installment: bigint | null; minDeposit: bigint } }
  | { ok: false; errors: ProductErrors } {
  const errors: ProductErrors = {};
  const code = form.code.trim().toUpperCase();
  if (!code) errors.code = "required";
  else if (!/^[A-Z0-9-]{1,12}$/.test(code)) errors.code = "code_format";

  const nameEn = form.nameEn.trim();
  if (!nameEn) errors.nameEn = "required";
  else if (nameEn.length > 80) errors.nameEn = "too_long";
  const nameBn = form.nameBn?.trim() || null;
  if (nameBn && nameBn.length > 80) errors.nameBn = "too_long";

  const frequency = SAVINGS_FREQUENCIES.find((f) => f === form.frequency);
  if (!frequency) errors.frequency = "invalid_frequency";

  let installment: bigint | null = null;
  if (frequency && frequency !== "flexible") {
    const v = money(form.installment);
    if (v === null) errors.installment = "required";
    else if (v === "invalid") errors.installment = "invalid_amount";
    else if (v === "too_large") errors.installment = "too_large";
    else installment = v;
  }

  let minDeposit = 1_00n;
  const min = money(form.minDeposit);
  if (min === "invalid") errors.minDeposit = "invalid_amount";
  else if (min === "too_large") errors.minDeposit = "too_large";
  else if (min !== null) minDeposit = min;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { code, nameEn, nameBn, frequency: frequency!, installment, minDeposit } };
}

export async function createProduct(
  ctx: TenantTx,
  form: ProductForm,
  actor: { userId: string; device?: string },
): Promise<{ ok: true; id: string } | { ok: false; errors: ProductErrors }> {
  const checked = checkProductForm(form);
  if (!checked.ok) return checked;
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .insert(savingsProduct)
    .values({ tenantId, ...checked.value, createdBy: actor.userId })
    .onConflictDoNothing({ target: [savingsProduct.tenantId, savingsProduct.code] })
    .returning({ id: savingsProduct.id });
  if (!row) return { ok: false, errors: { code: "code_taken" } };
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: "savings.product.create",
    entityType: "savings_product",
    entityId: row.id,
    after: { ...checked.value, installment: checked.value.installment?.toString() ?? null, minDeposit: checked.value.minDeposit.toString() },
    device: actor.device,
  });
  return { ok: true, id: row.id };
}

/** Switches a product on or off. Open accounts carry on; no new ones open while it is off. */
export async function setProductActive(
  ctx: TenantTx,
  productId: string,
  active: boolean,
  actor: { userId: string; device?: string },
): Promise<boolean> {
  const { tx, tenantId } = ctx;
  const [row] = await tx
    .update(savingsProduct)
    .set({ active })
    .where(and(eq(savingsProduct.tenantId, tenantId), eq(savingsProduct.id, productId)))
    .returning({ id: savingsProduct.id });
  if (!row) return false;
  await recordAudit(ctx, {
    actorUserId: actor.userId,
    action: active ? "savings.product.activate" : "savings.product.deactivate",
    entityType: "savings_product",
    entityId: productId,
    after: { active },
    device: actor.device,
  });
  return true;
}

export async function listProducts({ tx, tenantId }: TenantTx, opts: { activeOnly?: boolean } = {}): Promise<SavingsProductView[]> {
  const rows = await tx
    .select({
      id: savingsProduct.id,
      code: savingsProduct.code,
      nameEn: savingsProduct.nameEn,
      nameBn: savingsProduct.nameBn,
      frequency: savingsProduct.frequency,
      installment: savingsProduct.installment,
      minDeposit: savingsProduct.minDeposit,
      active: savingsProduct.active,
      openAccounts: sql<number>`(
        select count(*)::int from savings_account a
         where a.tenant_id = "savings_product"."tenant_id" and a.product_id = "savings_product"."id" and a.status = 'active'
      )`,
      balance: sql<string>`(
        select coalesce(sum(t.amount), 0) from savings_transaction t
          join savings_account a on a.tenant_id = t.tenant_id and a.id = t.account_id
         where t.tenant_id = "savings_product"."tenant_id" and a.product_id = "savings_product"."id"
           and not exists (select 1 from journal_entry r where r.tenant_id = t.tenant_id and r.reverses_id = t.journal_entry_id)
      )`.mapWith((v: string | number) => BigInt(v)),
    })
    .from(savingsProduct)
    .where(and(eq(savingsProduct.tenantId, tenantId), opts.activeOnly ? eq(savingsProduct.active, true) : undefined))
    .orderBy(asc(savingsProduct.code));
  return rows as SavingsProductView[];
}
