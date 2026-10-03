import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { canManageMembers, nextMemberNo } from "@/modules/members";
import { requireUser } from "../../auth";
import { AdmitForm } from "./admit-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("members.form");
  return { title: t("title") };
}

export default async function NewMemberPage() {
  const user = await requireUser();
  const t = await getTranslations("members");
  if (!canManageMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;

  const { nextNo, businessDate } = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx
      .select({ businessDate: tenant.businessDate })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId));
    return { nextNo: await nextMemberNo(ctx), businessDate: somiti!.businessDate };
  });

  return (
    <div className="members">
      <header className="page-head">
        <div>
          <Link href="/members" className="crumb">
            ← {t("profile.back")}
          </Link>
          <h1>{t("form.title")}</h1>
          <p className="muted">{t("form.subtitle")}</p>
        </div>
      </header>
      <AdmitForm nextNo={nextNo} businessDate={businessDate} businessDateLabel={formatDate(businessDate, locale)} />
    </div>
  );
}
