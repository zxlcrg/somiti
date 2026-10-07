import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { toBanglaDigits } from "@/lib/digits";
import { formatBdPhone } from "@/lib/phone";
import { canViewBooks } from "@/modules/ledger";
import { canViewMembers } from "@/modules/members";
import { requireUser } from "../auth";
import { signOutAction } from "../sign-in/actions";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("dashboard") };
}

const tileIcons = {
  members: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  vouchers: "M4 4h16v16l-3-2-3 2-2-2-2 2-3-2-3 2V4zm4 5h8M8 13h5",
  trialBalance: "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7zm14 0l-3 7a3 3 0 0 0 6 0l-3-7z",
};

export default async function DashboardPage() {
  const user = await requireUser();
  const locale = await getLocale();
  const t = await getTranslations();
  const bn = locale === "bn";
  const name = (bn ? (user.nameBn ?? user.nameEn) : (user.nameEn ?? user.nameBn)) ?? "";
  const somitiName = (bn ? (user.somiti.nameBn ?? user.somiti.nameEn) : (user.somiti.nameEn ?? user.somiti.nameBn)) ?? "";
  const phone = formatBdPhone(user.phone);
  const tiles = (["members", "vouchers", "trialBalance"] as const).map((key) => ({
    key,
    title: t(`dashboard.tiles.${key}`),
    body: t(`dashboard.tiles.${key}Body`),
  }));

  return (
    <div className="dash">
      <section className="welcome">
        <div className="avatar" aria-hidden="true">
          {name.trim().charAt(0) || "৳"}
        </div>
        <div>
          <h1>{t("dashboard.greeting", { name })}</h1>
          <dl className="facts">
            <div>
              <dt>{t("dashboard.somiti")}</dt>
              <dd>{somitiName}</dd>
            </div>
            <div>
              <dt>{t("dashboard.phone")}</dt>
              <dd>{bn ? toBanglaDigits(phone) : phone}</dd>
            </div>
            <div>
              <dt>{t("dashboard.roles")}</dt>
              <dd className="chips">
                {user.roles.map((r) => (
                  <span key={r} className="chip">
                    {t(`roles.${r}` as "roles.admin")}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </div>
        <form action={signOutAction} className="welcome-action">
          <button className="btn ghost">{t("nav.signOut")}</button>
        </form>
      </section>

      <h2 className="section-title">{t("dashboard.comingTitle")}</h2>
      <section className="features">
        {tiles.map((tile) => {
          const href = { members: "/members", vouchers: "/vouchers", trialBalance: "/trial-balance" }[tile.key];
          const live = tile.key === "members" ? canViewMembers(user.roles) : canViewBooks(user.roles);
          const body = (
            <>
              <span className={`pill${live ? " live" : ""}`}>{live ? t("dashboard.tiles.membersOpen") : t("dashboard.soon")}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={tileIcons[tile.key]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <h3>{tile.title}</h3>
              <p>{tile.body}</p>
            </>
          );
          return live ? (
            <Link href={href} className="feature soon live" key={tile.key}>
              {body}
            </Link>
          ) : (
            <article className="feature soon" key={tile.key}>
              {body}
            </article>
          );
        })}
      </section>
    </div>
  );
}
