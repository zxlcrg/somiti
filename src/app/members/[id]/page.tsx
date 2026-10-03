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
import { canViewMembers, getMember } from "@/modules/members";
import { requireUser } from "../../auth";
import { MemberAvatar, memberHue } from "../member-avatar";

async function load(id: string) {
  const user = await requireUser();
  if (!canViewMembers(user.roles)) return { user, member: null, addedBy: null };
  return withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const member = await getMember(ctx, id);
    if (!member) return { user, member: null, addedBy: null };
    const [addedBy] = await ctx.tx
      .select({ nameEn: appUser.nameEn, nameBn: appUser.nameBn })
      .from(appUser)
      .where(and(eq(appUser.tenantId, ctx.tenantId), eq(appUser.id, member.createdBy)));
    return { user, member, addedBy: addedBy ?? null };
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

const soonIcons = {
  savings: "M4 7h16v12H4zM4 7l2-3h12l2 3M9 12h6",
  loans: "M3 12h18M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4",
  nominees: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0",
  photo: "M4 7h4l2-3h4l2 3h4v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
};

export default async function MemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ admitted?: string }>;
}) {
  const tDash = await getTranslations("dashboard");
  const t = await getTranslations("members");
  const { user, member, addedBy } = await load((await params).id);
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  if (!member) notFound();

  const raw = await getLocale();
  const locale: Locale = isLocale(raw) ? raw : defaultLocale;
  const justAdmitted = (await searchParams).admitted === "1";
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
        <MemberAvatar member={member} locale={locale} size="lg" />
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

      <h2 className="section-title">{t("profile.soonTitle")}</h2>
      <section className="features">
        {(["savings", "loans", "nominees", "photo"] as const).map((k) => (
          <article className="feature soon" key={k}>
            <span className="pill">{tDash("soon")}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={soonIcons[k]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3>{t(`profile.soon.${k}`)}</h3>
            <p>{t(`profile.soon.${k}Body`)}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
