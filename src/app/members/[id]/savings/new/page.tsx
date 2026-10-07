import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { primaryName } from "@/lib/names";
import { getMember } from "@/modules/members";
import { canManageSavings, listProducts, memberAccounts } from "@/modules/savings";
import { requireUser } from "../../../../auth";
import { pageLocale } from "../../../../books";
import { MemberAvatar } from "../../../member-avatar";
import { OpenAccountForm } from "./open-account-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.panel");
  return { title: t("open") };
}

export default async function OpenAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canManageSavings(user.roles)) return <p className="notice">{t("openErrors.forbidden")}</p>;
  const { id } = await params;
  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const member = await getMember(ctx, id);
    if (!member) return null;
    return { member, products: await listProducts(ctx, { activeOnly: true }), accounts: await memberAccounts(ctx, id) };
  });
  if (!data) notFound();
  const locale = await pageLocale();
  const name = primaryName(data.member, locale);
  if (data.member.status !== "active") return <p className="notice">{t("openErrors.member_inactive")}</p>;
  const openProducts = new Set(data.accounts.filter((a) => a.status === "active").map((a) => a.productId));

  return (
    <div className="members savings">
      <Link href={`/members/${id}`} className="crumb">
        ← {name}
      </Link>
      <header className="page-head buy-head">
        <MemberAvatar member={data.member} locale={locale} />
        <div>
          <h1>{t("openForm.title", { name })}</h1>
          <p className="muted">{t("openForm.subtitle")}</p>
        </div>
      </header>
      {data.products.length === 0 ? (
        <p className="notice">{t("panel.noProducts")}</p>
      ) : (
        <OpenAccountForm
          memberId={id}
          memberName={name}
          products={data.products.map((p) => ({
            id: p.id,
            code: p.code,
            name: primaryName(p, locale),
            frequency: p.frequency,
            installment: p.installment?.toString() ?? null,
            taken: openProducts.has(p.id),
          }))}
        />
      )}
    </div>
  );
}
