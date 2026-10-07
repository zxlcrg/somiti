import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { canViewMembers } from "@/modules/members";
import { getCurrentUser } from "./auth";
import { LanguageSwitcher } from "./language-switcher";
import { signOutAction } from "./sign-in/actions";
import "./globals.css";
import "./auth.css";
import "./members.css";
import "./nominees.css";
import "./photo.css";
import "./shares.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return { title: { default: t("name"), template: `%s · ${t("name")}` }, description: t("tagline") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations();
  const user = await getCurrentUser();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <header className="topbar">
            <Link href={user ? "/dashboard" : "/"} className="brand" aria-label={t("app.name")}>
              <span className="logo" aria-hidden="true">
                ৳
              </span>
              <span className="brand-name">{t("app.name")}</span>
            </Link>
            <nav className="topbar-actions">
              {user && canViewMembers(user.roles) && (
                <Link href="/members" className="nav-link">
                  {t("nav.members")}
                </Link>
              )}
              <LanguageSwitcher />
              {user ? (
                <form action={signOutAction}>
                  <button className="btn ghost small">{t("nav.signOut")}</button>
                </form>
              ) : (
                <Link href="/sign-in" className="btn primary small">
                  {t("nav.signIn")}
                </Link>
              )}
            </nav>
          </header>
          <main>{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
