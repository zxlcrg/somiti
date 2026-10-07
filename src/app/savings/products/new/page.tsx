import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { canManageSavings } from "@/modules/savings";
import { requireUser } from "../../../auth";
import { ProductForm } from "./product-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.productForm");
  return { title: t("title") };
}

export default async function NewProductPage() {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canManageSavings(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  return (
    <div className="savings">
      <Link href="/savings" className="crumb">
        ← {t("title")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("productForm.title")}</h1>
          <p className="muted">{t("productForm.subtitle")}</p>
        </div>
      </header>
      <ProductForm />
    </div>
  );
}
