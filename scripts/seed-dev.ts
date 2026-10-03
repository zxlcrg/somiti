/**
 * Creates a demo somiti with a few balanced entries, for local development.
 * Usage: DATABASE_URL=... pnpm db:seed
 */
import { createDb, resolveTenantSlug, withTenant } from "../src/db/client";
import { todayInDhaka } from "../src/lib/dates";
import { formatAmount } from "../src/lib/format";
import { accountIdsByKey, postEntry, trialBalance } from "../src/modules/ledger";
import { createTenant } from "../src/modules/tenancy/create-tenant";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url);

const today = todayInDhaka();
// "demo" is easy to type on the sign-in page; later runs get a unique code.
const slug = (await resolveTenantSlug(db, "demo")) ? `demo-${Date.now()}` : "demo";
const adminPhone = "+8801700000000";
const somiti = await createTenant(db, {
  slug,
  nameEn: "Demo Somiti",
  nameBn: "ডেমো সমিতি",
  businessDate: today,
  admin: { nameEn: "Demo Admin", nameBn: "ডেমো অ্যাডমিন", phone: adminPhone },
});

await withTenant(db, somiti.tenantId, async (ctx) => {
  const a = await accountIdsByKey(ctx, ["cash_in_hand", "member_savings", "share_capital", "bank"]);
  const base = { branchId: somiti.branchId, createdBy: somiti.adminUserId, source: "manual_voucher" as const };
  await postEntry(ctx, {
    ...base,
    narration: "Share purchase",
    lines: [
      { accountId: a.cash_in_hand, debit: 50_000_00n },
      { accountId: a.share_capital, credit: 50_000_00n },
    ],
  });
  await postEntry(ctx, {
    ...base,
    narration: "Savings deposits",
    lines: [
      { accountId: a.cash_in_hand, debit: 12_500_00n },
      { accountId: a.member_savings, credit: 12_500_00n },
    ],
  });
  await postEntry(ctx, {
    ...base,
    narration: "Cash deposited to bank",
    lines: [
      { accountId: a.bank, debit: 40_000_00n },
      { accountId: a.cash_in_hand, credit: 40_000_00n },
    ],
  });

  const tb = await trialBalance(ctx, today);
  const col = (p: bigint) => formatAmount(p, "en").padStart(14);
  console.log(`Demo somiti ${somiti.tenantId}, trial balance as of ${today}:`);
  for (const r of tb.rows) console.log(`  ${r.code} ${(r.nameEn ?? "").padEnd(28)} ${col(r.debit)} ${col(r.credit)}`);
  console.log(`  ${"Total".padEnd(33)} ${col(tb.totalDebit)} ${col(tb.totalCredit)}`);
});

console.log(`\nSign in at http://localhost:3000/sign-in with somiti code "${slug}" and mobile 01700-000000.`);
console.log("The code is printed in the terminal running pnpm dev.");

await pool.end();
