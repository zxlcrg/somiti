"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Updates ?q= as the person types, after a short pause, keeping the other filters. */
export function SearchBox({ label, placeholder }: { label: string; placeholder: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get("q") ?? "");
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function update(next: string) {
    setValue(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const query = new URLSearchParams(params);
      if (next.trim()) query.set("q", next.trim());
      else query.delete("q");
      query.delete("page");
      startTransition(() => router.replace(`${pathname}?${query}`, { scroll: false }));
    }, 250);
  }

  return (
    <label className={`search${pending ? " is-pending" : ""}`}>
      <span className="sr-only">{label}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => update(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {value && (
        <button type="button" className="clear" onClick={() => update("")} aria-label="×">
          ×
        </button>
      )}
    </label>
  );
}
