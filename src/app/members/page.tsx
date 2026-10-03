import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { isLocale, defaultLocale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatInteger } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import { formatBdPhone } from "@/lib/phone";
import { canManageMembers, canViewMembers, listMembers, memberStats, type MemberStatus } from "@/modules/members";
import { requireUser } from "../auth";
import { MemberAvatar } from "./member-avatar";
import { SearchBox } from "./search-box";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("members");
  return { title: t("title") };
}

const PAGE_SIZE = 24;
const STATUSES = ["active", "exited", "deceased"] as const;

type Search = { q?: string; status?: string; sort?: string; page?: string };

function href(current: Search, change: Partial<Search>): string {
  const next = new URLSearchParams();
  const merged = { ...current, ...change };
  for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
  const query = next.toString();
  return query ? `/members?${query}` : "/members";
}

export default async function MembersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const t = await getTranslations("members");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;

  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const search = await searchParams;
  const status = STATUSES.includes(search.status as MemberStatus) ? (search.status as MemberStatus) : undefined;
  const sort = search.sort === "name" ? "name" : "number";
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);

  const { members, total, stats } = await withTenant(getAppDb(), user.tenantId, async (ctx) => ({
    ...(await listMembers(ctx, { q: search.q, status, sort, locale, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })),
    stats: await memberStats(ctx),
  }));

  const somiti = primaryName(user.somiti, locale);
  const canManage = canManageMembers(user.roles);
  const num = (n: number) => formatInteger(n, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const tiles = [
    { key: "total", value: stats.total, tone: "a" },
    { key: "active", value: stats.active, tone: "b" },
    { key: "thisMonth", value: stats.admittedThisMonth, tone: "c" },
  ] as const;

  return (
    <div className="members">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">{t("subtitle", { somiti })}</p>
        </div>
        {canManage && (
          <Link href="/members/new" className="btn primary">
            <span aria-hidden="true">＋</span> {t("add")}
          </Link>
        )}
      </header>

      <section className="stat-row">
        {tiles.map((tile) => (
          <div className={`stat-tile tone-${tile.tone}`} key={tile.key}>
            <span>{t(`stats.${tile.key}`)}</span>
            <strong>{num(tile.value)}</strong>
          </div>
        ))}
      </section>

      <section className="toolbar">
        <SearchBox label={t("searchLabel")} placeholder={t("searchPlaceholder")} />
        <nav className="chips-nav" aria-label={t("searchLabel")}>
          <Link href={href(search, { status: undefined, page: undefined })} aria-current={!status ? "true" : undefined}>
            {t("filters.all")}
          </Link>
          {STATUSES.map((s) => (
            <Link key={s} href={href(search, { status: s, page: undefined })} aria-current={status === s ? "true" : undefined}>
              {t(`filters.${s}`)}
            </Link>
          ))}
        </nav>
        <nav className="sort-toggle" aria-label={t("sort.label")}>
          {(["number", "name"] as const).map((s) => (
            <Link key={s} href={href(search, { sort: s === "number" ? undefined : s, page: undefined })} aria-current={sort === s ? "true" : undefined}>
              {t(`sort.${s}`)}
            </Link>
          ))}
        </nav>
      </section>

      {members.length === 0 ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{search.q ? t("empty.searchTitle", { q: search.q }) : t("empty.title")}</h2>
          <p className="muted">{search.q ? t("empty.searchBody") : t("empty.body")}</p>
          {!search.q && canManage && (
            <Link href="/members/new" className="btn primary">
              {t("add")}
            </Link>
          )}
        </section>
      ) : (
        <>
          <ul className="member-grid">
            {members.map((m, i) => {
              const second = secondaryName(m, locale);
              return (
                <li key={m.id} style={{ "--i": i } as React.CSSProperties}>
                  <Link href={`/members/${m.id}`} className="member-card">
                    <MemberAvatar member={m} locale={locale} />
                    <div className="member-card-body">
                      <div className="member-card-top">
                        <span className="member-no">#{num(m.memberNo)}</span>
                        <span className={`status-pill ${m.status}`}>{t(`status.${m.status}`)}</span>
                      </div>
                      <strong className="member-name">{primaryName(m, locale)}</strong>
                      {second && <span className="member-name-alt">{second}</span>}
                      <span className="member-meta">
                        <span>{digits(formatBdPhone(m.phone))}</span>
                        <span>{t("joined", { date: formatDate(m.admissionDate, locale) })}</span>
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <footer className="pager">
            <span className="muted">
              {t("showing", {
                from: (page - 1) * PAGE_SIZE + 1,
                to: (page - 1) * PAGE_SIZE + members.length,
                total,
              })}
            </span>
            <span className="pager-links">
              {page > 1 && <Link href={href(search, { page: page === 2 ? undefined : String(page - 1) })}>{t("previous")}</Link>}
              {page * PAGE_SIZE < total && <Link href={href(search, { page: String(page + 1) })}>{t("next")}</Link>}
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
