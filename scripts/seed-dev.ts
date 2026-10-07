/**
 * Creates a demo somiti with a few balanced entries, for local development.
 * Usage: DATABASE_URL=... pnpm db:seed
 */
import { createDb, resolveTenantSlug, withTenant } from "../src/db/client";
import { todayInDhaka } from "../src/lib/dates";
import { formatAmount } from "../src/lib/format";
import { appUser, userRole } from "../src/db/schema";
import { accountIdsByKey, approveVoucher, postEntry, submitVoucher, trialBalance } from "../src/modules/ledger";
import { admitMember, buyShares } from "../src/modules/members";
import { createProduct, deposit, openAccount } from "../src/modules/savings";
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

  // A second officer, so a voucher made by one can be approved by the other.
  const secretaryPhone = "+8801700000001";
  const [sec] = await ctx.tx
    .insert(appUser)
    .values({ tenantId: ctx.tenantId, nameEn: "Demo Secretary", nameBn: "ডেমো সম্পাদক", phone: secretaryPhone })
    .returning({ id: appUser.id });
  await ctx.tx.insert(userRole).values({ tenantId: ctx.tenantId, userId: sec!.id, role: "secretary" });

  const e = await accountIdsByKey(ctx, ["cash_in_hand", "sms_expense"]);
  const voucher = (narration: string, taka: string, createdBy: string) =>
    submitVoucher(ctx, {
      narration,
      lines: [
        { accountId: e.sms_expense, debit: taka, credit: "" },
        { accountId: e.cash_in_hand, debit: "", credit: taka },
      ],
      branchId: somiti.branchId,
      createdBy,
      device: "seed",
    });
  const paid = await voucher("SMS bundle for October", "500", somiti.adminUserId);
  if (!paid.ok) throw new Error(`seed voucher: ${JSON.stringify(paid.errors)}`);
  await approveVoucher(ctx, { voucherId: paid.voucherId, userId: sec!.id, device: "seed" });
  // Waiting for the admin: made by the secretary.
  const waiting = await voucher("SMS top-up", "250", sec!.id);
  if (!waiting.ok) throw new Error(`seed voucher: ${JSON.stringify(waiting.errors)}`);
  console.log("Added a demo secretary and two sample vouchers (one waiting for the admin).");

  const sampleMembers = [
    { nameEn: "Rahima Begum", nameBn: "রহিমা বেগম", guardianRelation: "husband", guardianNameBn: "আব্দুল করিম", phone: "01711000001", commLocale: "bn" },
    { nameEn: "Abdul Karim", nameBn: "আব্দুল করিম", guardianNameEn: "Mohammad Ali", phone: "01811000002", nid: "1987654321" },
    { nameEn: "Ayesha Khatun", nameBn: "আয়েশা খাতুন", guardianRelation: "husband", guardianNameEn: "Jamal Uddin", phone: "01911000003" },
    { nameBn: "সালমা আক্তার", guardianNameBn: "নূরুল ইসলাম", phone: "01611000004", commLocale: "bn" },
    { nameEn: "Jamal Uddin", guardianNameEn: "Kamal Uddin", phone: "01511000005", address: "Ward 3, Savar" },
    { nameEn: "Fatema Akter", nameBn: "ফাতেমা আক্তার", phone: "01311000006" },
  ] as const;
  // The demo admin also works the cash desk, so the demo can take payments.
  await ctx.tx.insert(userRole).values({ tenantId: somiti.tenantId, userId: somiti.adminUserId, role: "cashier" });
  // Savings products as a typical somiti runs them, and a field collector for daily rounds.
  const products: Record<string, string> = {};
  for (const p of [
    { code: "DS", nameEn: "Daily savings", nameBn: "দৈনিক সঞ্চয়", frequency: "daily", installment: "20" },
    { code: "WS", nameEn: "Weekly savings", nameBn: "সাপ্তাহিক সঞ্চয়", frequency: "weekly", installment: "100" },
    { code: "DPS", nameEn: "Monthly DPS", nameBn: "মাসিক ডিপিএস", frequency: "monthly", installment: "500" },
    { code: "GS", nameEn: "General savings", nameBn: "সাধারণ সঞ্চয়", frequency: "flexible" },
  ]) {
    const made = await createProduct(ctx, p, { userId: somiti.adminUserId, device: "seed" });
    if (!made.ok) throw new Error(`seed product: ${JSON.stringify(made.errors)}`);
    products[p.code] = made.id;
  }
  const [collector] = await ctx.tx
    .insert(appUser)
    .values({ tenantId: ctx.tenantId, nameEn: "Demo Collector", nameBn: "ডেমো মাঠকর্মী", phone: "+8801700000002" })
    .returning({ id: appUser.id });
  await ctx.tx.insert(userRole).values({ tenantId: ctx.tenantId, userId: collector!.id, role: "field_collector" });
  // Which products each sample member saves in, and what they have paid today.
  const savingsPlan: [string, string][][] = [
    [["DS", "20"], ["DPS", "500"]],
    [["WS", "100"], ["GS", "2000"]],
    [["DS", ""]],
    [["DPS", "1000"], ["GS", "750"]],
    [["DS", "40"]],
    [["WS", ""]],
  ];

  for (const [i, m] of sampleMembers.entries()) {
    const admitted = await admitMember(ctx, m, { userId: somiti.adminUserId, device: "seed" });
    if (!admitted.ok) throw new Error(`seed member: ${JSON.stringify(admitted.errors)}`);
    const bought = await buyShares(
      ctx,
      { memberId: admitted.member.id, shares: [5, 10, 3, 20, 5, 8][i]!, method: "cash", idempotencyKey: `seed-shares-${admitted.member.id}` },
      { userId: somiti.adminUserId, device: "seed" },
    );
    if (!bought.ok) throw new Error(`seed shares: ${JSON.stringify(bought.errors)}`);
    for (const [code, paid] of savingsPlan[i]!) {
      const opened = await openAccount(ctx, { memberId: admitted.member.id, productId: products[code]! }, { userId: somiti.adminUserId, device: "seed" });
      if (!opened.ok) throw new Error(`seed account: ${JSON.stringify(opened.errors)}`);
      if (!paid) continue;
      const done = await deposit(
        ctx,
        { accountId: opened.accountId, amount: paid, method: "cash", idempotencyKey: `seed-deposit-${opened.accountId}` },
        { userId: code === "DS" ? collector!.id : somiti.adminUserId, channel: code === "DS" ? "collector" : "office", device: "seed" },
      );
      if (!done.ok) throw new Error(`seed deposit: ${JSON.stringify(done.errors)}`);
    }
  }
  console.log(`Admitted ${sampleMembers.length} sample members, each with some shares and savings.`);

  const tb = await trialBalance(ctx, today);
  const col = (p: bigint) => formatAmount(p, "en").padStart(14);
  console.log(`Demo somiti ${somiti.tenantId}, trial balance as of ${today}:`);
  for (const r of tb.rows) console.log(`  ${r.code} ${(r.nameEn ?? "").padEnd(28)} ${col(r.debit)} ${col(r.credit)}`);
  console.log(`  ${"Total".padEnd(33)} ${col(tb.totalDebit)} ${col(tb.totalCredit)}`);
});

console.log(`\nSign in at http://localhost:3000/sign-in with somiti code "${slug}" and mobile 01700-000000.`);
console.log('To try approvals, sign in as the secretary with mobile 01700-000001.');
console.log("To take deposits on a collection round, sign in as the collector with mobile 01700-000002.");
console.log("The code is printed in the terminal running pnpm dev.");

await pool.end();
