import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { and, eq } from "drizzle-orm";
import { getAppDb, withTenant } from "@/db/client";
import { appUser } from "@/db/schema";
import { defaultLocale, isLocale, type Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatInteger } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import { formatBdPhone } from "@/lib/phone";
import {
  canManageMembers,
  canRecordPayments,
  canViewMembers,
  getMember,
  listNominees,
  shareHolding,
  sharePrice,
} from "@/modules/members";
import { canApplyForLoans, canViewLoans, listLoans, type LoanView } from "@/modules/loans";
import { canManageSavings, canTakeDeposits, listProducts, memberAccounts } from "@/modules/savings";
import { requireUser } from "../../auth";
import { MemberAvatar, memberHue } from "../member-avatar";
import { LoansPanel } from "./loans-panel";
import { NomineesPanel } from "./nominees-panel";
import { PhotoDialog } from "./photo/photo-dialog";
import { SavingsPanel } from "./savings-panel";
import { SharesPanel } from "./shares-panel";

async function load(id: string) {
  const user = await requireUser();
  const none = { user, member: null, addedBy: null, nominees: [], holding: null, price: 0n, accounts: [], hasProducts: false, loans: [] as LoanView[] };
  if (!canViewMembers(user.roles)) return none;
  return withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const member = await getMember(ctx, id);
    if (!member) return none;
    const [addedBy] = await ctx.tx
      .select({ nameEn: appUser.nameEn, nameBn: appUser.nameBn })
      .from(appUser)
      .where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.id, member.createdBy)));
    return {
      user,
      member,
      addedBy: addedBy ?? null,
      nominees: await listNominees(ctx, member.id),
      holding: await shareHolding(ctx, member.id),
      price: await sharePrice(ctx),
      accounts: await memberAccounts(ctx, member.id),
      hasProducts: (await listProducts(ctx, { activeOnly: true })).length > 0,
      loans: canViewLoans(user.roles) ? await listLoans(ctx, { memberId: member.id }) : [],
    };
  });
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { member } = await load((await params).id);
  const raw = await getLocale();
  return { title: member ? primaryName(member, isLocale(raw) ? raw : defaultLocale) : undefined };
}

/** Whole years between two ISO dates. */
function ageOn(birth: string, on: string): number {
  const [by, bm, bd] = birth.split("-").map(Number) as [number, number, number];
  const [oy, om, od] = on.split("-").map(Number) as [number, number, number];
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}

export default async function MemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ admitted?: string; nominees?: string; bought?: string }>;
}) {
  const t = await getTranslations("members");
  const { user, member, addedBy, nominees, holding, price, accounts, hasProducts, loans } = await load((await params).id);
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  if (!member) notFound();

  const raw = await getLocale();
  const locale: Locale = isLocale(raw) ? raw : defaultLocale;
  const search = await searchParams;
  const justAdmitted = search.admitted === "1";
  const nomineeNotice = search.nominees === "saved" || search.nominees === "unchanged" ? search.nominees : undefined;
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const name = primaryName(member, locale);
  const second = secondaryName(member, locale);
  const guardian = { nameEn: member.guardianNameEn, nameBn: member.guardianNameBn };
  const commLocale = member.commLocale ?? user.somiti.defaultLocale;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());

  const facts: { label: string; value: React.ReactNode }[] = [
    ...(member.guardianRelation && (guardian.nameEn || guardian.nameBn)
      ? [{ label: t(`profile.guardian.${member.guardianRelation}`), value: primaryName(guardian, locale) }]
      : []),
    { label: t("profile.phone"), value: digits(formatBdPhone(member.phone)) },
    {
      label: t("profile.nid"),
      value: member.nidLast4 ? `•••• ${digits(member.nidLast4)}` : <span className="muted">{t("profile.none")}</span>,
    },
    {
      label: t("profile.dob"),
      value: member.dateOfBirth ? (
        <>
          {formatDate(member.dateOfBirth, locale)}{" "}
          <span className="muted">· {t("profile.age", { age: ageOn(member.dateOfBirth, today) })}</span>
        </>
      ) : (
        <span className="muted">{t("profile.none")}</span>
      ),
    },
    { label: t("profile.address"), value: member.address ?? <span className="muted">{t("profile.none")}</span> },
    { label: t("profile.commLocale"), value: t(`languages.${commLocale}`) },
    { label: t("profile.admissionDate"), value: formatDate(member.admissionDate, locale) },
    ...(addedBy ? [{ label: t("profile.addedBy"), value: primaryName(addedBy, locale) }] : []),
  ];

  return (
    <div className="members">
      <Link href="/members" className="crumb">
        ← {t("profile.back")}
      </Link>

      {justAdmitted && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">🎉</span> {t("profile.admitted", { name })}
        </p>
      )}

      <section className="profile-hero" style={{ "--h": memberHue(member.memberNo) } as React.CSSProperties}>
        {canManageMembers(user.roles) ? (
          <PhotoDialog
            memberId={member.id}
            hasPhoto={!!member.photoVersion}
            trigger={<MemberAvatar member={member} locale={locale} size="lg" />}
          />
        ) : (
          <MemberAvatar member={member} locale={locale} size="lg" />
        )}
        <div className="profile-id">
          <div className="member-card-top">
            <span className="member-no">#{formatInteger(member.memberNo, locale)}</span>
            <span className={`status-pill ${member.status}`}>{t(`status.${member.status}`)}</span>
          </div>
          <h1>{name}</h1>
          {second && <p className="profile-alt">{second}</p>}
        </div>
      </section>

      <dl className="profile-facts">
        {facts.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>

      <SavingsPanel
        accounts={accounts}
        memberId={member.id}
        memberName={name}
        locale={locale}
        canOpen={canManageSavings(user.roles) && member.status === "active"}
        canDeposit={canTakeDeposits(user.roles) && member.status === "active"}
        hasProducts={hasProducts}
      />

      {canViewLoans(user.roles) && (
        <LoansPanel
          loans={loans}
          memberId={member.id}
          memberName={name}
          locale={locale}
          canApply={canApplyForLoans(user.roles) && member.status === "active"}
        />
      )}

      {holding && (
        <SharesPanel
          holding={holding}
          price={price}
          memberId={member.id}
          memberName={name}
          locale={locale}
          canBuy={canRecordPayments(user.roles) && member.status === "active"}
          boughtId={search.bought}
        />
      )}

      <NomineesPanel
        nominees={nominees}
        memberId={member.id}
        memberName={name}
        locale={locale}
        canEdit={canManageMembers(user.roles) && member.status === "active"}
        notice={nomineeNotice}
      />
    </div>
  );
}
