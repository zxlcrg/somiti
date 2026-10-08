import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { primaryName } from "@/lib/names";
import { getMember } from "@/modules/members";
import { canApplyForLoans, listLoanProducts, listLoans } from "@/modules/loans";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { MemberAvatar } from "../../members/member-avatar";
import { ApplyForm } from "./apply-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("loans.apply");
  return { title: t("title") };
}

export default async function ApplyPage({ searchParams }: { searchParams: Promise<{ member?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("loans");
  if (!canApplyForLoans(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const { member: memberId } = await searchParams;
  if (!memberId || !/^[0-9a-f-]{36}$/i.test(memberId)) notFound();
  const locale = await pageLocale();
  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const m = await getMember(ctx, memberId);
    if (!m) return null;
    const [somiti] = await ctx.tx.select({ d: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
    return {
      member: m,
      products: await listLoanProducts(ctx, { activeOnly: true }),
      open: await listLoans(ctx, { memberId, status: ["applied", "approved", "disbursed"] }),
      today: somiti!.d,
    };
  });
  if (!data) notFound();
  const { member, products, open, today } = data;
  const name = primaryName(member, locale);

  return (
    <div className="loans">
      <Link href={`/members/${member.id}`} className="crumb">
        ← {name}
      </Link>
      <header className="page-head apply-head">
        <MemberAvatar member={member} locale={locale} size="lg" />
        <div>
          <h1>{t("apply.title")}</h1>
          <p className="muted">{t("apply.subtitle", { name })}</p>
        </div>
      </header>
      {member.status !== "active" ? (
        <p className="notice">{t("applyErrors.member_inactive")}</p>
      ) : products.length === 0 ? (
        <p className="notice">{t("apply.noProducts")}</p>
      ) : (
        <ApplyForm
          memberId={member.id}
          today={today}
          openProductIds={open.map((l) => l.product.id)}
          products={products.map((p) => ({
            id: p.id,
            code: p.code,
            name: primaryName(p, locale),
            method: p.method,
            chargeLabel: p.chargeLabel,
            rateBp: p.rateBp,
            frequency: p.frequency,
            minAmount: p.minAmount.toString(),
            maxAmount: p.maxAmount.toString(),
            maxInstallments: p.maxInstallments,
            processingFeeBp: p.processingFeeBp,
          }))}
        />
      )}
    </div>
  );
}
