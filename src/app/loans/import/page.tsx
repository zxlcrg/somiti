import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { formatDate } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { listLoanProducts } from "@/modules/loans";
import { canImportOpening } from "@/modules/opening";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { ImportFlow } from "./import-flow";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("loanImport");
  return { title: t("title") };
}

export default async function LoanImportPage() {
  const user = await requireUser();
  const t = await getTranslations("loanImport");
  if (!canImportOpening(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { products, businessDate } = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx.select({ businessDate: tenant.businessDate }).from(tenant).where(eq(tenant.id, ctx.tenantId));
    return { products: await listLoanProducts(ctx, { activeOnly: true }), businessDate: somiti!.businessDate };
  });

  return (
    <div className="loans opening">
      <header className="page-head">
        <div>
          <Link href="/loans" className="crumb">
            ← {t("backToLoans")}
          </Link>
          <h1>{t("title")}</h1>
          <p className="muted">{t("subtitle")}</p>
        </div>
      </header>
      <ImportFlow
        products={products.map((p) => ({ code: p.code, name: primaryName({ nameEn: p.nameEn, nameBn: p.nameBn }, locale) }))}
        dateLabel={formatDate(businessDate, locale)}
      />
    </div>
  );
}
