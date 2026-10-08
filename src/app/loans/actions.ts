"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAppDb, withTenant } from "@/db/client";
import { LedgerError, type LedgerErrorCode } from "@/modules/ledger";
import {
  applyForLoan,
  approveLoan,
  canApplyForLoans,
  canApproveLoans,
  canDisburseLoans,
  canManageLoanProducts,
  cancelLoan,
  createLoanProduct,
  disburseLoan,
  rejectLoan,
  repaymentChannel,
  repayLoan,
  setLoanProductActive,
  type LoanApplicationErrors,
  type LoanDecisionError,
  type LoanProductErrors,
  type RepaymentError,
} from "@/modules/loans";
import { getCurrentUser } from "../auth";
import { flushSms } from "../sms";

const LEDGER_MESSAGES = new Set<LedgerErrorCode>(["DAY_CLOSED", "NO_OPEN_PERIOD"]);
const device = async () => (await headers()).get("user-agent")?.slice(0, 200) ?? undefined;
const field = (form: FormData, name: string) => String(form.get(name) ?? "");

async function signedIn() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

// ---------- Products ----------

export interface LoanProductState {
  errors?: LoanProductErrors & { form?: "forbidden" | "server" };
  attempt?: number;
}

export async function createLoanProductAction(prev: LoanProductState, form: FormData): Promise<LoanProductState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await signedIn();
  if (!canManageLoanProducts(user.roles)) return { errors: { form: "forbidden" }, attempt };
  let result;
  try {
    const dev = await device();
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      createLoanProduct(
        ctx,
        {
          code: field(form, "code"),
          nameEn: field(form, "nameEn"),
          nameBn: field(form, "nameBn"),
          method: field(form, "method"),
          chargeLabel: field(form, "chargeLabel"),
          allocation: field(form, "allocation"),
          rate: field(form, "rate"),
          frequency: field(form, "frequency"),
          minAmount: field(form, "minAmount"),
          maxAmount: field(form, "maxAmount"),
          maxInstallments: field(form, "maxInstallments"),
          fee: field(form, "fee"),
        },
        { userId: user.userId, device: dev },
      ),
    );
  } catch (err) {
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  revalidatePath("/loans");
  redirect(`/loans?created=${result.id}`);
}

export async function setLoanProductActiveAction(productId: string, active: boolean): Promise<void> {
  const user = await signedIn();
  if (!canManageLoanProducts(user.roles)) return;
  const dev = await device();
  await withTenant(getAppDb(), user.tenantId, (ctx) => setLoanProductActive(ctx, productId, active, { userId: user.userId, device: dev }));
  revalidatePath("/loans");
}

// ---------- Applications ----------

export interface ApplyState {
  errors?: Omit<LoanApplicationErrors, "form"> & { form?: LoanApplicationErrors["form"] | "forbidden" | "server" };
  attempt?: number;
}

export async function applyForLoanAction(memberId: string, prev: ApplyState, form: FormData): Promise<ApplyState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await signedIn();
  if (!canApplyForLoans(user.roles)) return { errors: { form: "forbidden" }, attempt };
  let result;
  try {
    const dev = await device();
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      applyForLoan(
        ctx,
        {
          memberId,
          productId: field(form, "productId"),
          amount: field(form, "amount"),
          installments: field(form, "installments"),
          purpose: field(form, "purpose"),
          submitKey: field(form, "submitKey"),
        },
        { userId: user.userId, device: dev },
      ),
    );
  } catch (err) {
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, attempt };
  revalidatePath("/", "layout");
  redirect(`/loans/${result.loanId}?applied=1`);
}

// ---------- Decisions and payout ----------

export interface LoanStepState {
  error?: LoanDecisionError | "forbidden" | "server" | LedgerErrorCode;
  attempt?: number;
}

export async function loanStepAction(loanId: string, step: "approve" | "reject" | "cancel" | "disburse", prev: LoanStepState, form: FormData): Promise<LoanStepState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await signedIn();
  const allowed =
    step === "disburse" ? canDisburseLoans(user.roles) : step === "cancel" ? canApplyForLoans(user.roles) : canApproveLoans(user.roles);
  if (!allowed) return { error: "forbidden", attempt };
  let result;
  try {
    const dev = await device();
    const who = { loanId, userId: user.userId, device: dev };
    result = await withTenant(getAppDb(), user.tenantId, (ctx) => {
      if (step === "approve") return approveLoan(ctx, { ...who, meetingOn: field(form, "meetingOn"), note: field(form, "note") });
      if (step === "reject") return rejectLoan(ctx, { ...who, note: field(form, "note") });
      if (step === "cancel") return cancelLoan(ctx, { ...who, note: field(form, "note") });
      return disburseLoan(ctx, { ...who, method: field(form, "method"), paymentRef: field(form, "paymentRef") });
    });
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { error: err.code, attempt };
    console.error(err);
    return { error: "server", attempt };
  }
  if (!result.ok) return { error: result.error, attempt };
  revalidatePath("/", "layout");
  redirect(`/loans/${loanId}?done=${step}`);
}

// ---------- Repayments ----------

export interface RepayState {
  errors?: Partial<Record<"amount" | "method" | "paymentRef", RepaymentError>> & { form?: RepaymentError | "forbidden" | "server" | LedgerErrorCode };
  /** What is still owed, when the amount was more than that. */
  owed?: string;
  attempt?: number;
}

export async function repayLoanAction(loanId: string, prev: RepayState, form: FormData): Promise<RepayState> {
  const attempt = (prev.attempt ?? 0) + 1;
  const user = await signedIn();
  const channel = repaymentChannel(user.roles);
  if (!channel) return { errors: { form: "forbidden" }, attempt };
  let result;
  try {
    const dev = await device();
    result = await withTenant(getAppDb(), user.tenantId, (ctx) =>
      repayLoan(
        ctx,
        { loanId, amount: field(form, "amount"), method: field(form, "method"), paymentRef: field(form, "paymentRef"), idempotencyKey: field(form, "idempotencyKey") },
        { userId: user.userId, channel, device: dev },
      ),
    );
  } catch (err) {
    if (err instanceof LedgerError && LEDGER_MESSAGES.has(err.code)) return { errors: { form: err.code }, attempt };
    console.error(err);
    return { errors: { form: "server" }, attempt };
  }
  if (!result.ok) return { errors: result.errors, owed: result.owed?.toString(), attempt };
  await flushSms(user.tenantId);
  revalidatePath("/", "layout");
  redirect(`/loans/${loanId}?paid=${result.repayment.entryNo}${result.closed ? "&closed=1" : ""}`);
}
