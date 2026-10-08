import { randomUUID } from "node:crypto";
import { afterAll } from "vitest";
import { createDb, withTenant, type TenantTx } from "../src/db/client";
import { accountIdsByKey } from "../src/modules/ledger";
import { createTenant, type CreatedTenant } from "../src/modules/tenancy/create-tenant";
import { APP_URL, OWNER_URL } from "./env";

/** Connected as somiti_app, exactly like the running app. */
export const app = createDb(APP_URL);
/** Connected as somiti_owner, the role migrations run as. */
export const owner = createDb(OWNER_URL);

afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

export const ACCOUNT_KEYS = [
  "cash_in_hand",
  "cash_with_collector",
  "bank",
  "member_savings",
  "share_capital",
  "loans_receivable",
  "interest_income",
  "fine_income",
  "fee_income",
  "sms_expense",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export interface TestTenant extends CreatedTenant {
  accounts: Record<AccountKey, string>;
  run<T>(fn: (ctx: TenantTx) => Promise<T>): Promise<T>;
}

export async function newTenant(businessDate = "2026-10-03"): Promise<TestTenant> {
  const created = await createTenant(app.db, {
    slug: `test-${randomUUID()}`,
    nameEn: "Test Somiti",
    nameBn: "টেস্ট সমিতি",
    businessDate,
    admin: { nameEn: "Admin", phone: `+8801${Math.floor(Math.random() * 1e9)}` },
  });
  const run = <T>(fn: (ctx: TenantTx) => Promise<T>) => withTenant(app.db, created.tenantId, fn);
  const accounts = await run((ctx) => accountIdsByKey(ctx, ACCOUNT_KEYS));
  return { ...created, accounts, run };
}

/** A simple balanced deposit: Dr cash, Cr member savings. */
export function deposit(t: TestTenant, paisa: bigint, extra: Record<string, unknown> = {}) {
  return {
    branchId: t.branchId,
    source: "manual_voucher" as const,
    narration: "Savings deposit",
    createdBy: t.adminUserId,
    lines: [
      { accountId: t.accounts.cash_in_hand, debit: paisa },
      { accountId: t.accounts.member_savings, credit: paisa },
    ],
    ...extra,
  };
}
