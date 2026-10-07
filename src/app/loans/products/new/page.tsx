import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canManageLoanProducts } from "@/modules/loans";
import { requireUser } from "../../../auth";
import { LoanProductForm } from "./product-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("loans.productForm");
  return { title: t("title") };
}

export default async function NewLoanProductPage() {
  const user = await requireUser();
  const t = await getTranslations("loans");
  if (!canManageLoanProducts(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  return (
    <div className="loans">
      <Link href="/loans" className="crumb">
        ← {t("title")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("productForm.title")}</h1>
          <p className="muted">{t("productForm.subtitle")}</p>
        </div>
      </header>
      <LoanProductForm />
    </div>
  );
}
