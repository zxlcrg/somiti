import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatDateTime, formatTaka } from "@/lib/format";
import { primaryName, secondaryName } from "@/lib/names";
import { canApproveVouchers, canViewBooks, getVoucher } from "@/modules/ledger";
import { requireUser } from "../../auth";
import { pageLocale, voucherNo } from "../../books";
import { DecisionPanel } from "./decision-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("books.detail");
  return { title: t("title") };
}

export default async function VoucherPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ made?: string; done?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("books");
  const tType = await getTranslations("ledger.accountType");
  if (!canViewBooks(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { id } = await params;
  const { made, done } = await searchParams;
  const v = await withTenant(getAppDb(), user.tenantId, (ctx) => getVoucher(ctx, id));
  if (!v) notFound();

  const taka = (p: bigint) => formatTaka(p, locale);
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const isMaker = v.maker.id === user.userId;
  const mode = v.status !== "pending" ? null : isMaker ? "maker" : canApproveVouchers(user.roles) ? "checker" : null;
  const banner =
    made === "1" && v.status === "pending"
      ? t("detail.madeBanner")
      : done === "approve" && v.status === "approved"
        ? t("detail.approvedBanner", { no: voucherNo(v.entryNo!, locale) })
        : done === "reject" && v.status === "rejected"
          ? t("detail.rejectedBanner")
          : done === "cancel" && v.status === "cancelled"
            ? t("detail.cancelledBanner")
            : null;

  return (
    <div className="books">
      <Link href="/vouchers" className="crumb">
        ← {t("form.back")}
      </Link>
      {banner && <p className={`celebrate${done === "reject" || done === "cancel" ? " quiet" : ""}`}>{banner}</p>}

      <section className={`voucher-hero ${v.status}`}>
        <div>
          <span className={`status-pill ${v.status}`}>{t(`vouchers.status.${v.status}`)}</span>
          <h1>{taka(v.total)}</h1>
          <p>{v.narration}</p>
        </div>
        {v.entryNo !== null && (
          <div className="hero-entry">
            <span>{t("detail.entryNo")}</span>
            <strong>{voucherNo(v.entryNo, locale)}</strong>
            {v.entryBusinessDate && <small>{formatDate(v.entryBusinessDate, locale)}</small>}
          </div>
        )}
      </section>

      <div className="voucher-detail">
        <section className="lines-card">
          <h2>{t("detail.lines")}</h2>
          <div className="table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th scope="col">{t("form.account")}</th>
                  <th scope="col" className="num">
                    {t("form.debit")}
                  </th>
                  <th scope="col" className="num">
                    {t("form.credit")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.lines.map((l) => {
                  const alt = secondaryName(l, locale);
                  return (
                    <tr key={l.lineNo}>
                      <td>
                        <span className={`type-dot t-${l.type}`} title={tType(l.type)} aria-hidden="true" />
                        <span className="acct">
                          <span className="acct-code">{digits(l.code)}</span> {primaryName(l, locale)}
                          {alt && <small className="muted"> · {alt}</small>}
                          {l.memo && <small className="memo-text">{l.memo}</small>}
                        </span>
                      </td>
                      <td className="num debit">{l.debit > 0n ? taka(l.debit) : ""}</td>
                      <td className="num credit">{l.credit > 0n ? taka(l.credit) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{t("detail.total")}</th>
                  <td className="num">{taka(v.total)}</td>
                  <td className="num">{taka(v.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <aside className="voucher-side-col">
          <ol className="timeline">
            <li className="done">
              <strong>{t("detail.made", { name: primaryName(v.maker, locale) })}</strong>
              <small className="muted">{formatDateTime(v.createdAt, locale)}</small>
            </li>
            {v.status === "pending" ? (
              <li className="waiting">
                <strong>{t("detail.waiting")}</strong>
                <small className="muted">{t("detail.waitingWho")}</small>
              </li>
            ) : (
              <li className={v.status}>
                <strong>
                  {t(`detail.decided.${v.status}`, { name: v.checker ? primaryName(v.checker, locale) : "" })}
                </strong>
                {v.decidedAt && <small className="muted">{formatDateTime(v.decidedAt, locale)}</small>}
                {v.decisionNote && <q>{v.decisionNote}</q>}
              </li>
            )}
          </ol>
          {mode && <DecisionPanel voucherId={v.id} mode={mode} amount={taka(v.total)} />}
          {v.status === "pending" && !mode && <p className="muted small-note">{t("detail.cannotDecide")}</p>}
        </aside>
      </div>
    </div>
  );
}
