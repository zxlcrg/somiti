import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { addDays } from "@/lib/dates";
import { formatDate, formatDateTime, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canCloseDay, dayEndSummary, listDayCloses } from "@/modules/dayend";
import { canViewBooks } from "@/modules/ledger";
import { requireUser } from "../auth";
import { pageLocale, voucherNo } from "../books";
import { BooksTabs } from "../books-tabs";
import { CountForm } from "./count-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.dayEnd");
  return { title: t("title") };
}

export default async function DayEndPage({ searchParams }: { searchParams: Promise<{ closed?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("books");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const search = await searchParams;
  const { summary, closes } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    summary: await dayEndSummary(ctx),
    closes: await listDayCloses(ctx),
  }));
  const taka = (p: bigint) => formatTaka(p, locale);
  const d = (iso: string) => formatDate(iso, locale);
  const closer = canCloseDay(user.roles);
  const fresh = search.closed ? closes.find((c) => c.id === search.closed) : undefined;
  const freshDiff = fresh ? fresh.counted - fresh.expected : 0n;
  const abs = (p: bigint) => (p < 0n ? -p : p);

  const tiles = [
    { key: "opening", value: summary.cash.opening, tone: "b" },
    { key: "in", value: summary.cash.receipts, tone: "a", sign: "+" },
    { key: "out", value: summary.cash.payments, tone: "c", sign: "−" },
    { key: "expected", value: summary.cash.closing, tone: "e" },
  ] as const;
  const checks = [
    {
      key: "vouchers",
      ok: summary.pendingVouchers === 0,
      text: summary.pendingVouchers ? t("dayEnd.vouchersOpen", { count: summary.pendingVouchers }) : t("dayEnd.vouchersClear"),
      href: "/vouchers?status=pending",
    },
    {
      key: "withdrawals",
      ok: summary.pendingWithdrawals === 0,
      text: summary.pendingWithdrawals ? t("dayEnd.withdrawalsOpen", { count: summary.pendingWithdrawals }) : t("dayEnd.withdrawalsClear"),
      href: "/savings/withdrawals",
    },
    ...(summary.collectorsHolding.length
      ? summary.collectorsHolding.map((c) => ({
          key: `collector-${c.userId}`,
          ok: false,
          text: t("dayEnd.collectorsOpen", { name: primaryName(c, locale), amount: taka(c.held) }),
          href: "/savings/collections",
        }))
      : [{ key: "collectors", ok: true, text: t("dayEnd.collectorsClear"), href: "/savings/collections" }]),
  ];

  return (
    <div className="books day-end">
      <header className="page-head">
        <div>
          <h1>{t("dayEnd.title")}</h1>
          <p className="muted">
            {t("dayEnd.forDay", { date: d(summary.date) })} · {t("dayEnd.entries", { count: summary.entries })}
          </p>
        </div>
      </header>
      <BooksTabs active="dayEnd" />

      {fresh && (
        <p className="celebrate" role="status">
          <span aria-hidden="true">🔒</span>{" "}
          {freshDiff === 0n
            ? t("dayEnd.closed", { date: d(fresh.businessDate), amount: taka(fresh.counted), next: d(summary.date) })
            : t(freshDiff < 0n ? "dayEnd.closedShort" : "dayEnd.closedOver", {
                date: d(fresh.businessDate),
                amount: taka(fresh.counted),
                diff: taka(abs(freshDiff)),
                no: fresh.entryNo === null ? "" : voucherNo(fresh.entryNo, locale),
                next: d(summary.date),
              })}
        </p>
      )}

      <section className="stat-row four">
        {tiles.map((tile) => (
          <div className={`stat-tile tone-${tile.tone}`} key={tile.key}>
            <span>{t(`dayEnd.${tile.key}`)}</span>
            <strong className="money-figure">
              {"sign" in tile && tile.value > 0n ? tile.sign : ""}
              {taka(tile.value)}
            </strong>
          </div>
        ))}
      </section>

      <div className="day-end-grid">
        <section className="checklist-card">
          <h2>{t("dayEnd.checks")}</h2>
          <ul className="checklist">
            {checks.map((c) => (
              <li key={c.key} className={c.ok ? "ok" : "warn"}>
                <span className="check-icon" aria-hidden="true">
                  {c.ok ? "✓" : "!"}
                </span>
                {c.ok ? <span>{c.text}</span> : <Link href={c.href}>{c.text}</Link>}
              </li>
            ))}
          </ul>
          {checks.some((c) => !c.ok) && <p className="muted small-note">{t("dayEnd.checksHint")}</p>}
        </section>

        {closer ? (
          <CountForm
            key={summary.date}
            date={summary.date}
            dateLabel={d(summary.date)}
            nextLabel={d(addDays(summary.date, 1))}
            expected={summary.cash.closing.toString()}
          />
        ) : (
          <p className="notice">{t("dayEnd.noAccess")}</p>
        )}
      </div>

      <h2 className="section-title">{t("dayEnd.history")}</h2>
      {closes.length === 0 ? (
        <p className="muted">{t("dayEnd.historyNone")}</p>
      ) : (
        <ol className="close-history">
          {closes.map((c) => {
            const diff = c.counted - c.expected;
            const tone = diff === 0n ? "match" : diff < 0n ? "short" : "over";
            return (
              <li key={c.id} className={`${tone}${c.id === fresh?.id ? " fresh" : ""}`}>
                <span className="close-date">
                  <strong>{d(c.businessDate)}</strong>
                  <small className="muted">{t("dayEnd.by", { name: primaryName(c.closedBy, locale), time: formatDateTime(c.createdAt, locale) })}</small>
                </span>
                <span className="close-amount">
                  <strong className="money-figure">{taka(c.counted)}</strong>
                  <span className={`tally-chip ${tone}`}>
                    {tone === "match" ? t("dayEnd.match") : t(`dayEnd.${tone}`, { amount: taka(abs(diff)) })}
                    {c.entryNo !== null && ` · ${voucherNo(c.entryNo, locale)}`}
                  </span>
                </span>
                {c.note && <small className="close-note">{c.note}</small>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
