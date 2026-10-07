"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

/** Deposit and Withdraw share the side of the passbook; the page picks the starting tab. */
export function SideTabs({ deposit, withdraw, start }: { deposit: ReactNode; withdraw: ReactNode; start: "deposit" | "withdraw" }) {
  const t = useTranslations("savings.tabs");
  const [tab, setTab] = useState(start);
  return (
    <div className={`side-tabs on-${tab}`}>
      <div className="side-tab-bar" role="tablist" aria-label={t("deposit") + " / " + t("withdraw")}>
        {(["deposit", "withdraw"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            className={tab === k ? "on" : undefined}
            onClick={() => setTab(k)}
          >
            <span aria-hidden="true">{k === "deposit" ? "⬇️" : "⬆️"}</span> {t(k)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="panel-deposit" aria-labelledby="tab-deposit" hidden={tab !== "deposit"}>
        {deposit}
      </div>
      <div role="tabpanel" id="panel-withdraw" aria-labelledby="tab-withdraw" hidden={tab !== "withdraw"}>
        {withdraw}
      </div>
    </div>
  );
}
