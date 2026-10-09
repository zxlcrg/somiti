"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

export const NAV_ICONS = {
  dashboard: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z",
  members: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  savings: "M19 7c0-1.7-3.1-3-7-3S5 5.3 5 7m14 0c0 1.7-3.1 3-7 3S5 8.7 5 7m14 0v5c0 1.7-3.1 3-7 3s-7-1.3-7-3V7m14 5v5c0 1.7-3.1 3-7 3s-7-1.3-7-3v-5",
  sheet: "M9 4h6v3H9zM9 5H6v16h12V5h-3M9 11h1M13 11h3M9 15h1M13 15h3",
  collections: "M3 7h18v10H3zM7 7V5h10v2M12 10v4M9 12h6",
  loans: "M12 3v18M17 7.5C17 5.6 14.8 4 12 4S7 5.6 7 7.5 9.2 11 12 11s5 1.6 5 3.5S14.8 18 12 18s-5-1.6-5-3.5",
  overdue: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  vouchers: "M4 4h16v16l-3-2-3 2-2-2-2 2-3-2-3 2V4zm4 5h8M8 13h5",
  expenses: "M12 5v14M5 12h14",
  cashBook: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5zm0 14a2 2 0 0 1 2-2h13M9 7h6",
  trialBalance: "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7zm14 0l-3 7a3 3 0 0 0 6 0l-3-7z",
  dayEnd: "M20 15.5A8.5 8.5 0 0 1 8.5 4a8.5 8.5 0 1 0 11.5 11.5z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
} as const;

export interface SideItem {
  href: string;
  /** Other paths that belong to this item. */
  also?: string[];
  /** Paths under href that another item owns, e.g. /loans/overdue under /loans. */
  except?: string[];
  icon: keyof typeof NAV_ICONS;
  label: string;
  /** Count already written in the reader's digits, with what it means. */
  badge?: { text: string; label: string; tone?: "late" };
}

export interface SideGroup {
  label: string;
  items: SideItem[];
}

function isOn(path: string, item: SideItem): boolean {
  const under = (p: string) => path === p || path.startsWith(p + "/");
  if (item.except?.some(under)) return false;
  return [item.href, ...(item.also ?? [])].some(under);
}

/**
 * The signed-in navigation: a column down the left on wide screens, a bar
 * with a menu button on phones. The menu closes itself on navigation.
 */
export function SideNav({
  brand,
  groups,
  menuLabel,
  closeLabel,
  waiting,
  user,
  tools,
}: {
  brand: ReactNode;
  groups: SideGroup[];
  menuLabel: string;
  closeLabel: string;
  /** Anything waiting on this officer, so the closed menu button still shows it. */
  waiting: boolean;
  user: ReactNode;
  tools: ReactNode;
}) {
  const path = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="side-bar">
        <button
          type="button"
          className="menu-btn"
          aria-expanded={open}
          aria-controls="side-nav"
          aria-label={open ? closeLabel : menuLabel}
          onClick={() => setOpenAt(open ? null : path)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={open ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {waiting && !open && <span className="menu-dot" aria-hidden="true" />}
        </button>
        {brand}
      </div>
      <nav className="side-nav" id="side-nav" aria-label={groups[0]?.label}>
        {groups.map((g) => (
          <div className="side-group" key={g.label}>
            <span className="side-group-label">{g.label}</span>
            {g.items.map((item) => (
              <Link key={item.href} href={item.href} className="side-link" aria-current={isOn(path, item) ? "page" : undefined}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={NAV_ICONS[item.icon]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="side-label">{item.label}</span>
                {item.badge && (
                  <span className={`count-badge${item.badge.tone ? ` ${item.badge.tone}` : ""}`} aria-label={item.badge.label}>
                    {item.badge.text}
                  </span>
                )}
              </Link>
            ))}
          </div>
        ))}
        <div className="side-user">{user}</div>
      </nav>
      <div className="side-tools">{tools}</div>
    </aside>
  );
}
