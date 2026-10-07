import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { canApproveVouchers, canMakeVouchers, postableAccounts } from "@/modules/ledger";
import { requireUser } from "../../auth";
import { accountLabel, pageLocale } from "../../books";
import { VoucherForm, type AccountOption } from "./voucher-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.form");
  return { title: t("title") };
}

export default async function NewVoucherPage() {
  const user = await requireUser();
  const t = await getTranslations("books");
  if (!canMakeVouchers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const accounts = await withTenant(getAppDb(), user.tenantId, (ctx) => postableAccounts(ctx));
  const options: AccountOption[] = accounts.map((a) => ({ id: a.id, type: a.type, label: accountLabel(a, locale) }));

  return (
    <div className="books">
      <header className="page-head">
        <div>
          <Link href="/vouchers" className="crumb">
            ← {t("form.back")}
          </Link>
          <h1>{t("form.title")}</h1>
          <p className="muted">{canApproveVouchers(user.roles) ? t("form.subtitleChecker") : t("form.subtitle")}</p>
        </div>
      </header>
      {/* One key per form load: a double-click or a retried request makes one voucher. */}
      <VoucherForm accounts={options} submitKey={randomUUID()} />
    </div>
  );
}
