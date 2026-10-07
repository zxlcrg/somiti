import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canManageMembers, exitBlockers, exitSettlement, getMember, memberExits } from "@/modules/members";
import { requireUser } from "../../../auth";
import { MemberAvatar } from "../../member-avatar";
import { ExitForm } from "./exit-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("members.exit");
  return { title: t("title") };
}

export default async function ExitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("members.exit");
  if (!canManageMembers(user.roles)) return <p className="notice">{t("errors.forbidden")}</p>;
  const { id } = await params;

  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const member = await getMember(ctx, id);
    if (!member) return null;
    return {
      member,
      settlement: await exitSettlement(ctx, id),
      blockers: await exitBlockers(ctx, id),
      pending: (await memberExits(ctx, id)).some((e) => e.status === "pending"),
    };
  });
  if (!data) notFound();
  // A request is already waiting: that's decided on the member's page.
  if (data.pending) redirect(`/members/${id}#exit-title`);

  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const name = primaryName(data.member, locale);
  const taka = (p: bigint) => formatTaka(p, locale);
  const { settlement, blockers } = data;

  return (
    <div className="members">
      <Link href={`/members/${id}`} className="crumb">
        ← {name}
      </Link>
      <header className="page-head buy-head">
        <MemberAvatar member={data.member} locale={locale} />
        <div>
          <h1>{t("form.title", { name })}</h1>
          <p className="muted">{t("form.subtitle")}</p>
        </div>
      </header>

      <div className="buy-shares">
        <section className="buy-card settlement">
          <span className="label">{t("form.settlement")}</span>
          {settlement.total === 0n ? (
            <p className="muted">{t("form.nothing")}</p>
          ) : (
            <ul className="settlement-lines">
              {settlement.shareRefund > 0n && (
                <li>
                  <span aria-hidden="true">🪙</span>
                  <span>{t("form.shares", { count: settlement.shares })}</span>
                  <strong>{taka(settlement.shareRefund)}</strong>
                </li>
              )}
              {settlement.savings
                .filter((a) => a.balance > 0n)
                .map((a) => (
                  <li key={a.accountId}>
                    <span aria-hidden="true">🏦</span>
                    <span>{t("form.account", { code: a.productCode, no: a.accountNo })}</span>
                    <strong>{taka(a.balance)}</strong>
                  </li>
                ))}
            </ul>
          )}
          <div className="amount-due exit-due">
            <span>{t("form.total")}</span>
            <strong>{taka(settlement.total)}</strong>
          </div>
          <p className="muted small">{t("loansNote")}</p>
        </section>

        {blockers.length > 0 ? (
          <section className="buy-card exit-blocked" role="alert">
            <strong>{t("form.blocked")}</strong>
            <ul className="exit-blockers">
              {blockers.map((b) => (
                <li key={b}>{t(`blockers.${b}`)}</li>
              ))}
            </ul>
            <Link href={`/members/${id}`} className="btn ghost">
              ← {name}
            </Link>
          </section>
        ) : (
          <ExitForm memberId={id} />
        )}
      </div>
    </div>
  );
}
