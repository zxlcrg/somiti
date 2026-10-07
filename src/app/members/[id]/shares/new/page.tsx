import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canRecordPayments, getMember, shareHolding, sharePrice } from "@/modules/members";
import { requireUser } from "../../../../auth";
import { MemberAvatar } from "../../../member-avatar";
import { BuySharesForm } from "./buy-shares-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("members.shares");
  return { title: t("buy") };
}

export default async function BuySharesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("members");
  if (!canRecordPayments(user.roles)) return <p className="notice">{t("shares.errors.forbidden")}</p>;
  const { id } = await params;

  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const member = await getMember(ctx, id);
    if (!member) return null;
    return { member, holding: await shareHolding(ctx, member.id), price: await sharePrice(ctx) };
  });
  if (!data) notFound();
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const name = primaryName(data.member, locale);

  if (data.member.status !== "active") {
    return (
      <div className="members">
        <p className="notice">{t("shares.errors.member_inactive")}</p>
      </div>
    );
  }

  return (
    <div className="members">
      <Link href={`/members/${id}`} className="crumb">
        ← {name}
      </Link>
      <header className="page-head buy-head">
        <MemberAvatar member={data.member} locale={locale} />
        <div>
          <h1>{t("shares.form.title", { name })}</h1>
          <p className="muted">{t("shares.form.subtitle", { price: formatTaka(data.price, locale) })}</p>
        </div>
      </header>
      <BuySharesForm
        memberId={id}
        memberName={name}
        pricePaisa={data.price.toString()}
        heldShares={data.holding.shares}
        heldPaisa={data.holding.amount.toString()}
      />
    </div>
  );
}
