import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatInteger, formatTaka } from "@/lib/format";
import { canViewMembers } from "@/modules/members";
import { canApproveWithdrawals, canRequestWithdrawals, listWithdrawals } from "@/modules/savings";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { WithdrawalCard } from "./withdrawal-card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.withdrawals");
  return { title: t("title") };
}

export default async function WithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; decided?: string; kind?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const search = await searchParams;
  const decidedTab = search.show === "decided";
  const { pending, decided, just } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    pending: await listWithdrawals(ctx, { status: "pending", limit: 100 }),
    decided: await listWithdrawals(ctx, { status: ["approved", "rejected", "cancelled"], limit: 50 }),
    just: search.decided ? (await listWithdrawals(ctx, { id: search.decided, limit: 1 }))[0] : undefined,
  }));
  const viewer = { userId: user.userId, canApprove: canApproveWithdrawals(user.roles), canRequest: canRequestWithdrawals(user.roles) };
  const taka = (p: bigint) => formatTaka(p, locale);
  const list = decidedTab ? decided : pending;
  const returnTo = decidedTab ? "/savings/withdrawals?show=decided" : "/savings/withdrawals";

  return (
    <div className="savings">
      <Link href="/savings" className="crumb">
        ← {t("title")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("withdrawals.title")}</h1>
          <p className="muted">{t("withdrawals.subtitle")}</p>
        </div>
      </header>

      {just && just.status !== "pending" && (
        <p className={`celebrate${just.status === "approved" ? "" : " quiet"}`} role="status">
          {just.status === "approved"
            ? t("withdrawals.approvedBanner", { amount: taka(just.amount), no: formatInteger(just.entryNo ?? 0n, locale) })
            : t(just.status === "rejected" ? "withdrawals.rejectedBanner" : "withdrawals.cancelledBanner")}
        </p>
      )}

      <nav className="wd-tabs" aria-label={t("withdrawals.title")}>
        <Link href="/savings/withdrawals" aria-current={!decidedTab ? "page" : undefined}>
          ⏳ {t("withdrawals.pendingTab")}
          {pending.length > 0 && <span className="count-badge">{formatInteger(pending.length, locale)}</span>}
        </Link>
        <Link href="/savings/withdrawals?show=decided" aria-current={decidedTab ? "page" : undefined}>
          ✓ {t("withdrawals.decidedTab")}
        </Link>
      </nav>

      {list.length === 0 ? (
        <p className="muted all-good wd-empty">
          <span aria-hidden="true">{decidedTab ? "🗂️" : "✅"}</span> {decidedTab ? t("withdrawals.noneDecided") : t("withdrawals.nonePending")}
        </p>
      ) : (
        <div className="wd-list">
          {list.map((w) => (
            <WithdrawalCard key={w.id} w={w} locale={locale} viewer={viewer} returnTo={returnTo} showMember />
          ))}
        </div>
      )}
    </div>
  );
}
