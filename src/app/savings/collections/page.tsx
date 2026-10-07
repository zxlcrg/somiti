import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewMembers } from "@/modules/members";
import { canReceiveHandovers, collectorBoard, listHandovers } from "@/modules/savings";
import { requireUser } from "../../auth";
import { pageLocale } from "../../books";
import { HandoverForm } from "./handover-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.collections");
  return { title: t("title") };
}

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<{ received?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("savings");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { received } = await searchParams;
  const { board, history } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    board: await collectorBoard(ctx),
    history: await listHandovers(ctx, { limit: 20 }),
  }));
  const cashier = canReceiveHandovers(user.roles);
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const totalHeld = board.reduce((s, c) => s + (c.held > 0n ? c.held : 0n), 0n);
  const todayAmount = board.reduce((s, c) => s + c.todayAmount, 0n);
  const todayCount = board.reduce((s, c) => s + c.todayCount, 0);
  const fresh = received ? history.find((h) => h.id === received) : undefined;

  return (
    <div className="savings">
      <Link href="/savings" className="crumb">
        ← {t("title")}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("collections.title")}</h1>
          <p className="muted">{t("collections.subtitle")}</p>
        </div>
      </header>

      {fresh && (
        <p className="celebrate" role="status">
          {t("collections.received", {
            amount: taka(fresh.amount),
            name: primaryName({ nameEn: fresh.collectorEn, nameBn: fresh.collectorBn }, locale),
            no: num(fresh.entryNo),
          })}
        </p>
      )}

      <div className="stat-row two">
        <div className="stat-tile tone-c">
          <span>{t("collections.totalHeld")}</span>
          <strong className="money-figure">{taka(totalHeld)}</strong>
        </div>
        <div className="stat-tile tone-b">
          <span>{t("collections.today")}</span>
          <strong className="money-figure">{taka(todayAmount)}</strong>
          <small>{t("collections.todayCount", { count: todayCount })}</small>
        </div>
      </div>

      <h2 className="section-title">{t("collections.collectors")}</h2>
      {board.length === 0 ? (
        <p className="muted wd-empty">{t("collections.none")}</p>
      ) : (
        <div className="collector-grid">
          {board.map((c) => {
            const name = primaryName(c, locale);
            const me = c.userId === user.userId;
            const tone = c.held > 0n ? "holding" : c.held < 0n ? "owed" : "clear";
            return (
              <article key={c.userId} className={`collector-card ${tone}${me ? " me" : ""}`}>
                <div className="collector-head">
                  <span className="collector-avatar" aria-hidden="true">
                    {(name || "?").slice(0, 1)}
                  </span>
                  <div>
                    <strong>
                      {name} {me && <span className="chip">{t("collections.you")}</span>}
                    </strong>
                    <small className="muted">{c.phone.replace(/^\+88/, "")}</small>
                  </div>
                </div>
                <div className="collector-held">
                  <span>{t("collections.holding")}</span>
                  <strong>{taka(c.held > 0n ? c.held : 0n)}</strong>
                  {c.held === 0n && <span className="due-chip ok">{t("collections.allIn")}</span>}
                  {c.held < 0n && <span className="due-chip late">{t("collections.owed", { amount: taka(-c.held) })}</span>}
                </div>
                <p className="muted collector-line">
                  {t("collections.todayLine", { count: c.todayCount, amount: taka(c.todayAmount) })}
                </p>
                <p className="muted collector-line">
                  {c.lastHandover
                    ? t("collections.lastHandover", { amount: taka(c.lastHandover.amount), time: formatDateTime(c.lastHandover.at, locale) })
                    : t("collections.neverHanded")}
                </p>
                {me && c.held > 0n && <p className="approval-note">{t("collections.yourNote")}</p>}
                {cashier && !me && c.held > 0n && <HandoverForm collectorId={c.userId} collectorName={name} held={c.held.toString()} />}
              </article>
            );
          })}
        </div>
      )}

      <h2 className="section-title">{t("collections.history")}</h2>
      {history.length === 0 ? (
        <p className="muted wd-empty">{t("collections.noHistory")}</p>
      ) : (
        <ol className="recent-deposits handover-list">
          {history.map((h) => (
            <li key={h.id} className={`${h.reversed ? "reversed" : ""}${h.id === fresh?.id ? " fresh" : ""}`}>
              <span className="dep-icon" aria-hidden="true">
                🤝
              </span>
              <span className="who">
                <strong>{primaryName({ nameEn: h.collectorEn, nameBn: h.collectorBn }, locale)}</strong>
                <small className="muted">
                  {t("collections.receivedBy", { name: primaryName({ nameEn: h.receivedEn, nameBn: h.receivedBn }, locale) })} ·{" "}
                  {formatDateTime(h.createdAt, locale)} · {t("collections.entry", { no: num(h.entryNo) })}
                  {h.note ? ` · “${h.note}”` : ""}
                </small>
              </span>
              <span className="dep-amount">
                {taka(h.amount)}
                {h.reversed && <span className="chip">{t("collections.reversed")}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
