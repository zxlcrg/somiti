import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { canApproveVouchers, canViewBooks, pendingForChecker } from "@/modules/ledger";
import { canViewMembers } from "@/modules/members";
import { getCurrentUser } from "./auth";
import { LanguageSwitcher } from "./language-switcher";
import { signOutAction } from "./sign-in/actions";
import "./globals.css";
import "./auth.css";
import "./members.css";
import "./nominees.css";
import "./photo.css";
import "./books.css";
import "./shares.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return { title: { default: t("name"), template: `%s · ${t("name")}` }, description: t("tagline") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations();
  const user = await getCurrentUser();
  // Vouchers waiting for this officer, shown as a badge on the Accounts link.
  const waiting =
    user && canApproveVouchers(user.roles)
      ? await withTenant(getAppDb(), user.tenantId, (ctx) => pendingForChecker(ctx, user.userId))
      : 0;
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
              {user && canViewBooks(user.roles) && (
                <Link href="/vouchers" className="nav-link">
                  {t("nav.accounts")}
                  {waiting > 0 && (
                    <span className="count-badge" aria-label={t("nav.waiting", { count: waiting })}>
                      {waiting}
                    </span>
                  )}
                </Link>
              )}
              <LanguageSwitcher />
              {user ? (
                <form action={signOutAction}>
                  <button className="btn ghost small sign-out" title={t("nav.signOut")}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="sign-out-label">{t("nav.signOut")}</span>
                  </button>
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
