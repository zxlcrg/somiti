import Link from "next/link";
import { getTranslations } from "next-intl/server";

const TABS = [
  { key: "vouchers", href: "/vouchers", icon: "M4 4h16v16l-3-2-3 2-2-2-2 2-3-2-3 2V4zm4 5h8M8 13h5" },
  { key: "cashBook", href: "/cash-book", icon: "M3 7h18v12H3zM3 7l3-3h12l3 3M7 12h4M15 15h2" },
  { key: "trialBalance", href: "/trial-balance", icon: "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7zm14 0l-3 7a3 3 0 0 0 6 0l-3-7z" },
] as const;

/** Switches between the three books pages. */
export async function BooksTabs({ active, pending }: { active: (typeof TABS)[number]["key"]; pending?: number }) {
  const t = await getTranslations("books.tabs");
  return (
    <nav className="books-tabs" aria-label={t("label")}>
      {TABS.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={active === tab.key ? "page" : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={tab.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t(tab.key)}
          {tab.key === "vouchers" && pending ? <span className="count-badge">{pending}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
