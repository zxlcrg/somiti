import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatInteger } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canApproveVouchers, canViewBooks, pendingForChecker } from "@/modules/ledger";
import { canManageMembers, canViewMembers, exitsForChecker } from "@/modules/members";
import { canApproveLoans, canDisburseLoans, canViewLoans, loansWaitingFor, overdueCount } from "@/modules/loans";
import { canApproveWithdrawals, withdrawalsForChecker } from "@/modules/savings";
import { getCurrentUser } from "./auth";
import { SideNav, type SideGroup, type SideItem } from "./side-nav";
import { LanguageSwitcher } from "./language-switcher";
import { signOutAction } from "./sign-in/actions";
import "./globals.css";
import "./auth.css";
import "./members.css";
import "./nominees.css";
import "./photo.css";
import "./books.css";
import "./shares.css";
import "./savings.css";
import "./opening.css";
import "./loans.css";
import "./exit.css";
import "./dashboard.css";

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
  // Member exits waiting for this officer, on the Members link.
  const exits =
    user && canManageMembers(user.roles)
      ? await withTenant(getAppDb(), user.tenantId, (ctx) => exitsForChecker(ctx, user.userId))
      : 0;
  // Savings withdrawals waiting for this officer, on the Savings link.
  const withdrawals =
    user && canApproveWithdrawals(user.roles)
      ? await withTenant(getAppDb(), user.tenantId, (ctx) => withdrawalsForChecker(ctx, user.userId))
      : 0;
  // Loans waiting for this officer to approve or pay out, on the Loans link.
  const loansWaiting =
    user && canViewLoans(user.roles)
      ? await withTenant(getAppDb(), user.tenantId, (ctx) =>
          loansWaitingFor(ctx, user.userId, { decide: canApproveLoans(user.roles), pay: canDisburseLoans(user.roles) }),
        )
      : 0;
  // Running loans with an installment past its date, on the Overdue link.
  const overdue = user && canViewLoans(user.roles) ? await withTenant(getAppDb(), user.tenantId, (ctx) => overdueCount(ctx)) : 0;
  const somitiName = user ? primaryName(user.somiti, isLocale(locale) ? locale : defaultLocale) : "";
  const brand = (
    <Link href={user ? "/dashboard" : "/"} className="brand" aria-label={t("app.name")}>
      <span className="logo" aria-hidden="true">
        ৳
      </span>
      <span className="brand-name">{t("app.name")}</span>
    </Link>
  );
  const signOut = (
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
  );
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          {user ? (
            <div className="shell">
              <SideNav
                brand={brand}
                groups={sideGroups(user.roles, { exits, withdrawals, loansWaiting, overdue, waiting }, t, (n) => formatInteger(n, isLocale(locale) ? locale : defaultLocale))}
                menuLabel={t("nav.menu")}
                closeLabel={t("nav.closeMenu")}
                waiting={exits + withdrawals + loansWaiting + waiting > 0}
                user={
                  <>
                    <span className="side-avatar" aria-hidden="true">
                      {primaryName(user, isLocale(locale) ? locale : defaultLocale).trim().charAt(0) || "৳"}
                    </span>
                    <span>
                      <strong>{primaryName(user, isLocale(locale) ? locale : defaultLocale)}</strong>
                      <small>
                        {user.roles.map((r) => t(`roles.${r}` as "roles.admin")).join(" · ")}
                        {somitiName && ` · ${somitiName}`}
                      </small>
                    </span>
                  </>
                }
                tools={
                  <>
                    <LanguageSwitcher />
                    {signOut}
                  </>
                }
              />
              <main>{children}</main>
            </div>
          ) : (
            <>
              <header className="topbar">
                {brand}
                <div className="topbar-actions">
                  <LanguageSwitcher />
                  <Link href="/sign-in" className="btn primary small">
                    {t("nav.signIn")}
                  </Link>
                </div>
              </header>
              <main>{children}</main>
            </>
          )}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

type Counts = { exits: number; withdrawals: number; loansWaiting: number; overdue: number; waiting: number };

/** The menu this officer's roles open, with what waits on them. */
function sideGroups(roles: readonly string[], c: Counts, t: Awaited<ReturnType<typeof getTranslations>>, num: (n: number) => string): SideGroup[] {
  const badge = (n: number, label: string, tone?: "late") => (n > 0 ? { text: num(n), label, tone } : undefined);
  const main: SideItem[] = [{ href: "/dashboard", icon: "dashboard", label: t("nav.dashboard") }];
  if (canViewMembers(roles)) {
    main.push({ href: "/members", icon: "members", label: t("nav.members"), badge: badge(c.exits, t("nav.exitsWaiting", { count: c.exits })) });
    main.push({
      href: "/savings",
      icon: "savings",
      label: t("nav.savings"),
      except: ["/savings/collections"],
      badge: badge(c.withdrawals, t("nav.savingsWaiting", { count: c.withdrawals })),
    });
    main.push({ href: "/savings/collections", icon: "collections", label: t("nav.collections") });
  }
  if (canViewLoans(roles)) {
    main.push({
      href: "/loans",
      icon: "loans",
      label: t("nav.loans"),
      except: ["/loans/overdue"],
      badge: badge(c.loansWaiting, t("nav.loansWaiting", { count: c.loansWaiting })),
    });
    main.push({ href: "/loans/overdue", icon: "overdue", label: t("nav.overdue"), badge: badge(c.overdue, t("nav.overdueCount", { count: c.overdue }), "late") });
  }
  const groups: SideGroup[] = [{ label: t("nav.label"), items: main }];
  if (canViewBooks(roles))
    groups.push({
      label: t("nav.accounts"),
      items: [
        { href: "/vouchers", icon: "vouchers", label: t("nav.vouchers"), except: ["/vouchers/new"], badge: badge(c.waiting, t("nav.waiting", { count: c.waiting })) },
        { href: "/vouchers/new", icon: "expenses", label: t("nav.expenses") },
        { href: "/cash-book", icon: "cashBook", label: t("nav.cashBook") },
        { href: "/trial-balance", icon: "trialBalance", label: t("nav.trialBalance") },
        { href: "/day-end", icon: "dayEnd", label: t("nav.dayEnd") },
      ],
    });
  return groups;
}
