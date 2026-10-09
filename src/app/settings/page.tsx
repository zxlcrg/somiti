import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import type { Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatMonth } from "@/lib/format";
import { toTakaDecimal } from "@/lib/money";
import { formatBdPhone } from "@/lib/phone";
import { canManageSettings, getSomitiSettings, listStaff, STAFF_ROLES } from "@/modules/tenancy";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { SomitiForm } from "./somiti-form";
import { StaffBoard, type StaffCard } from "./staff-board";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("title") };
}

/** "2026-07" to "2027-06" for a business date in that fiscal year. */
function fiscalYear(businessDate: string, startMonth: number): { start: string; end: string } {
  const [y, m] = businessDate.split("-").map(Number) as [number, number];
  const startYear = m >= startMonth ? y : y - 1;
  const endMonth = ((startMonth + 10) % 12) + 1;
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${startYear}-${pad(startMonth)}`, end: `${endYear}-${pad(endMonth)}` };
}

export default async function SettingsPage() {
  const user = await requireUser();
  const t = await getTranslations("settings");
  if (!canManageSettings(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale: Locale = await pageLocale();

  const { somiti, staff } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    somiti: await getSomitiSettings(ctx),
    staff: await listStaff(ctx),
  }));
  const fy = fiscalYear(somiti.businessDate, somiti.fiscalYearStartMonth);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const cards: StaffCard[] = staff.map((s) => ({
    id: s.id,
    nameEn: s.nameEn,
    nameBn: s.nameBn,
    phone: s.phone,
    phoneLabel: digits(formatBdPhone(s.phone)),
    localPhone: formatBdPhone(s.phone),
    isActive: s.isActive,
    roles: s.roles,
    since: formatDate(s.createdAt.toISOString().slice(0, 10), locale),
  }));

  return (
    <div className="settings">
      <header className="page-head settings-head">
        <div>
          <h1>
            <span className="settings-gear" aria-hidden="true">
              ⚙
            </span>{" "}
            {t("title")}
          </h1>
          <p className="muted">{t("subtitle")}</p>
        </div>
      </header>

      <SomitiForm
        slug={somiti.slug}
        businessDate={formatDate(somiti.businessDate, locale)}
        fiscalYear={t("somiti.fiscalYearValue", { start: formatMonth(fy.start, locale, "long"), end: formatMonth(fy.end, locale, "long") })}
        initial={{
          nameEn: somiti.nameEn ?? "",
          nameBn: somiti.nameBn ?? "",
          defaultLocale: somiti.defaultLocale,
          sharePrice: toTakaDecimal(somiti.sharePrice).replace(/\.00$/, ""),
        }}
      />

      <StaffBoard staff={cards} me={user.userId} roles={[...STAFF_ROLES]} />
    </div>
  );
}
