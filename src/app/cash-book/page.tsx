import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { fiscalYearContaining } from "@/lib/dates";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { CASH_BOOK_KEYS, canViewBooks, cashBook, postableAccounts, type CashBook } from "@/modules/ledger";
import { requireUser } from "../auth";
import { pageLocale, voucherNo } from "../books";
import { BooksTabs } from "../books-tabs";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.cashBook");
  return { title: t("title") };
}

type Search = { account?: string; from?: string; to?: string };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A small running-balance line, so the day's movement reads at a glance. */
function BalanceSpark({ book, label }: { book: CashBook; label: string }) {
  const points = [book.opening, ...book.rows.map((r) => r.balance)];
  if (points.length < 2) return null;
  const lo = points.reduce((a, b) => (b < a ? b : a));
  const hi = points.reduce((a, b) => (b > a ? b : a));
  const span = hi - lo || 1n;
  const w = 600;
  const h = 80;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 6 - Number(((p - lo) * BigInt(h - 12)) / span)] as const);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="url(#spark-fill)" />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export default async function CashBookPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const t = await getTranslations("books");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const search = await searchParams;

  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const [somiti] = await ctx.tx
      .select({ businessDate: tenant.businessDate, startMonth: tenant.fiscalYearStartMonth })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId));
    const accounts = (await postableAccounts(ctx)).filter((a) =>
      (CASH_BOOK_KEYS as readonly string[]).includes(a.systemKey ?? ""),
    );
    const today = somiti!.businessDate;
    const account = accounts.find((a) => a.systemKey === search.account) ?? accounts.find((a) => a.systemKey === "cash_in_hand") ?? accounts[0]!;
    let from = search.from && ISO.test(search.from) ? search.from : today;
    let to = search.to && ISO.test(search.to) ? search.to : today;
    if (from > to) [from, to] = [to, from];
    const book = await cashBook(ctx, { accountId: account.id, from, to });
    return { today, startMonth: somiti!.startMonth, accounts, account, book };
  });
  const { today, account, book } = data;

  const taka = (p: bigint) => formatTaka(p, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const year = fiscalYearContaining(today, data.startMonth);
  const presets = [
    { key: "today", from: today, to: today },
    { key: "month", from: `${today.slice(0, 8)}01`, to: today },
    { key: "year", from: year.startDate, to: today },
  ] as const;
  const q = (change: Partial<Search>) => {
    const p = new URLSearchParams({ account: account.systemKey ?? "", from: book.from, to: book.to, ...change });
    return `/cash-book?${p}`;
  };
  const oneDay = book.from === book.to;
  const tiles = [
    { key: "opening", value: book.opening, tone: "b" },
    { key: "receipts", value: book.receipts, tone: "a", sign: "+" },
    { key: "payments", value: book.payments, tone: "c", sign: "−" },
    { key: "closing", value: book.closing, tone: "e" },
  ] as const;

  return (
    <div className="books">
      <header className="page-head">
        <div>
          <h1>{t("cashBook.title")}</h1>
          <p className="muted">
            {oneDay
              ? t("cashBook.forDay", { date: formatDate(book.from, locale) })
              : t("cashBook.forRange", { from: formatDate(book.from, locale), to: formatDate(book.to, locale) })}
          </p>
        </div>
      </header>
      <BooksTabs active="cashBook" />

      <section className="toolbar books-toolbar">
        <nav className="chips-nav" aria-label={t("cashBook.accountLabel")}>
          {data.accounts.map((a) => (
            <Link key={a.id} href={q({ account: a.systemKey ?? "" })} aria-current={a.id === account.id ? "true" : undefined}>
              {primaryName(a, locale)}
            </Link>
          ))}
        </nav>
        <nav className="sort-toggle" aria-label={t("cashBook.rangeLabel")}>
          {presets.map((p) => (
            <Link key={p.key} href={q({ from: p.from, to: p.to })} aria-current={book.from === p.from && book.to === p.to ? "true" : undefined}>
              {t(`cashBook.presets.${p.key}`)}
            </Link>
          ))}
        </nav>
        <form className="date-range" action="/cash-book">
          <input type="hidden" name="account" value={account.systemKey ?? ""} />
          <label>
            <span>{t("cashBook.from")}</span>
            <input type="date" name="from" defaultValue={book.from} max={today} />
          </label>
          <label>
            <span>{t("cashBook.to")}</span>
            <input type="date" name="to" defaultValue={book.to} max={today} />
          </label>
          <button className="btn ghost small">{t("cashBook.show")}</button>
        </form>
      </section>

      <section className="stat-row four">
        {tiles.map((tile) => (
          <div className={`stat-tile tone-${tile.tone}`} key={tile.key}>
            <span>{t(`cashBook.${tile.key}`)}</span>
            <strong className="money-figure">
              {"sign" in tile && tile.value > 0n ? tile.sign : ""}
              {taka(tile.value)}
            </strong>
          </div>
        ))}
      </section>

      <BalanceSpark book={book} label={t("cashBook.sparkLabel")} />

      {book.rows.length === 0 ? (
        <section className="empty">
          <div className="empty-art" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <h2>{t("cashBook.empty")}</h2>
          <p className="muted">{t("cashBook.emptyBody", { amount: taka(book.closing) })}</p>
        </section>
      ) : (
        <div className="table-wrap lines-card">
          <table className="ledger-table cash-table">
            <thead>
              <tr>
                {!oneDay && <th scope="col">{t("cashBook.date")}</th>}
                <th scope="col">{t("cashBook.entry")}</th>
                <th scope="col">{t("cashBook.particulars")}</th>
                <th scope="col" className="num">
                  {t("cashBook.receipt")}
                </th>
                <th scope="col" className="num">
                  {t("cashBook.payment")}
                </th>
                <th scope="col" className="num">
                  {t("cashBook.balance")}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="opening-row">
                {!oneDay && <td />}
                <td />
                <td>{t("cashBook.broughtForward")}</td>
                <td />
                <td />
                <td className="num">{taka(book.opening)}</td>
              </tr>
              {book.rows.map((r, i) => (
                <tr key={`${r.entryId}-${i}`} className={r.receipt > 0n ? "in" : "out"}>
                  {!oneDay && <td className="nowrap">{formatDate(r.businessDate, locale)}</td>}
                  <td className="nowrap muted">{voucherNo(r.entryNo, locale)}</td>
                  <td>
                    <span className="particulars">{r.narration}</span>
                    {r.contra.length > 0 && (
                      <small className="muted contra">
                        {r.receipt > 0n ? t("cashBook.fromAccounts") : t("cashBook.toAccounts")}{" "}
                        {r.contra.map((c) => `${digits(c.code)} ${primaryName(c, locale)}`).join(", ")}
                      </small>
                    )}
                    {r.source === "reversal" && <span className="chip reversal">{t("cashBook.reversal")}</span>}
                  </td>
                  <td className="num debit">{r.receipt > 0n ? taka(r.receipt) : ""}</td>
                  <td className="num credit">{r.payment > 0n ? taka(r.payment) : ""}</td>
                  <td className="num">{taka(r.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {!oneDay && <td />}
                <td />
                <th scope="row">{t("cashBook.carriedForward")}</th>
                <td className="num">{taka(book.receipts)}</td>
                <td className="num">{taka(book.payments)}</td>
                <td className="num">{taka(book.closing)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
