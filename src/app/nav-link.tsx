"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** A header link that marks itself current on its own section, e.g. /savings/accounts/… under Savings. */
export function NavLink({ href, also = [], children }: { href: string; also?: string[]; children: ReactNode }) {
  const path = usePathname();
  const on = [href, ...also].some((p) => path === p || path.startsWith(p + "/"));
  return (
    <Link href={href} className="nav-link" aria-current={on ? "page" : undefined}>
      {children}
    </Link>
  );
}
