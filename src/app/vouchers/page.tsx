import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import {
  canApproveVouchers,
  canMakeVouchers,
  canViewBooks,
  listVouchers,
  pendingForChecker,
  VOUCHER_STATUSES,
  voucherStats,
  type VoucherStatus,
} from "@/modules/ledger";
import { requireUser } from "../auth";
import { pageLocale, voucherNo } from "../books";
import { BooksTabs } from "../books-tabs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.vouchers");
  return { title: t("title") };
}

const PAGE_SIZE = 30;

export default async function VouchersPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("books");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const search = await searchParams;
  const status = VOUCHER_STATUSES.includes(search.status as VoucherStatus) ? (search.status as VoucherStatus) : undefined;
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  const { list, stats, waiting } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    list: await listVouchers(ctx, { status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    stats: await voucherStats(ctx),
    waiting: await pendingForChecker(ctx, user.userId),
  }));
  const canApprove = canApproveVouchers(user.roles);
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const href = (s?: VoucherStatus) => (s ? `/vouchers?status=${s}` : "/vouchers");

  return (
    <div className="books">
      <header className="page-head">
        <div>
          <h1>{t("vouchers.title")}</h1>
          <p className="muted">{t("vouchers.subtitle")}</p>
        </div>
        {canMakeVouchers(user.roles) && (
          <Link href="/vouchers/new" className="btn primary">
            <span aria-hidden="true">＋</span> {t("vouchers.new")}
          </Link>
        )}
      </header>
      <BooksTabs active="vouchers" pending={canApprove ? waiting : undefined} />

      <section className="stat-row">
        <div className="stat-tile tone-c">
          <span>{t("vouchers.stats.pending")}</span>
          <strong>{num(stats.pending.count)}</strong>
          <small>{taka(stats.pending.total)}</small>
        </div>
        <div className="stat-tile tone-a">
          <span>{t("vouchers.stats.approved")}</span>
          <strong>{num(stats.approvedThisMonth.count)}</strong>
          <small>{taka(stats.approvedThisMonth.total)}</small>
        </div>
        <div className="stat-tile tone-d">
          <span>{t("vouchers.stats.rejected")}</span>
          <strong>{num(stats.rejected)}</strong>
        </div>
      </section>

      {canApprove && waiting > 0 && !status && (
        <Link href={href("pending")} className="attention">
          <span className="attention-dot" aria-hidden="true" />
          {t("vouchers.waitingForYou", { count: waiting })}
          <span aria-hidden="true">→</span>
        </Link>
      )}

      <nav className="chips-nav voucher-filter" aria-label={t("vouchers.filterLabel")}>
        <Link href={href()} aria-current={!status ? "true" : undefined}>
          {t("vouchers.filters.all")}
        </Link>
        {VOUCHER_STATUSES.map((s) => (
          <Link key={s} href={href(s)} aria-current={status === s ? "true" : undefined}>
            {t(`vouchers.status.${s}`)}
          </Link>
        ))}
      </nav>

      {list.vouchers.length === 0 ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{status ? t("vouchers.empty.filtered") : t("vouchers.empty.title")}</h2>
          <p className="muted">{t("vouchers.empty.body")}</p>
          {!status && canMakeVouchers(user.roles) && (
            <Link href="/vouchers/new" className="btn primary">
              {t("vouchers.new")}
            </Link>
          )}
        </section>
      ) : (
        <>
          <ul className="voucher-list">
            {list.vouchers.map((v, i) => {
              const yours = v.status === "pending" && canApprove && v.maker.id !== user.userId;
              return (
                <li key={v.id} style={{ "--i": i } as React.CSSProperties}>
                  <Link href={`/vouchers/${v.id}`} className={`voucher-card ${v.status}${yours ? " needs-you" : ""}`}>
                    <span className="voucher-amount">{taka(v.total)}</span>
                    <span className="voucher-main">
                      <strong>{v.narration}</strong>
                      <span className="muted">
                        {t("vouchers.madeBy", {
                          name: primaryName(v.maker, locale),
                          when: formatDateTime(v.createdAt, locale),
                        })}
                      </span>
                    </span>
                    <span className="voucher-side">
                      <span className={`status-pill ${v.status}`}>{t(`vouchers.status.${v.status}`)}</span>
                      {v.entryNo !== null && <span className="muted">{t("vouchers.entry", { no: voucherNo(v.entryNo, locale) })}</span>}
                      {yours && <span className="needs-you-tag">{t("vouchers.needsYou")}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <footer className="pager">
            <span className="muted">
              {t("vouchers.showing", {
                from: (page - 1) * PAGE_SIZE + 1,
                to: (page - 1) * PAGE_SIZE + list.vouchers.length,
                total: list.total,
              })}
            </span>
            <span className="pager-links">
              {page > 1 && <Link href={`${href(status)}${status ? "&" : "?"}page=${page - 1}`}>{t("previous")}</Link>}
              {page * PAGE_SIZE < list.total && (
                <Link href={`${href(status)}${status ? "&" : "?"}page=${page + 1}`}>{t("next")}</Link>
              )}
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
