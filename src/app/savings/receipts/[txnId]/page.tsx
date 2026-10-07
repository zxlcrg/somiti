import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { isLocale, type Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatDate, formatDateTime, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { formatBdPhone } from "@/lib/phone";
import { canViewMembers } from "@/modules/members";
import { getReceipt } from "@/modules/savings";
import { requireUser } from "../../../auth";
import { pageLocale } from "../../../books";
import { PrintButton } from "../print-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("savings.receipt");
  return { title: t("title") };
}

/** A printable receipt (deposit) or payment slip (withdrawal), in the member's language by default. */
export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ txnId: string }>; searchParams: Promise<{ lang?: string }> }) {
  const user = await requireUser();
  const page = await pageLocale();
  const tPage = await getTranslations("savings");
  if (!canViewMembers(user.roles)) return <p className="notice">{tPage("noAccess")}</p>;
  const { txnId } = await params;
  const search = await searchParams;
  const r = await withTenant(getAppDb(), user.tenantId, (ctx) => getReceipt(ctx, txnId));
  if (!r) notFound();

  const locale: Locale = search.lang && isLocale(search.lang) ? search.lang : r.memberLocale;
  const t = await getTranslations({ locale, namespace: "savings" });
  const tp = await getTranslations({ locale: page, namespace: "savings.receipt" });
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number | bigint) => formatInteger(n, locale);
  const { txn, account: a, member: m } = r;
  const deposit = txn.kind === "deposit";
  const fine = txn.fine ?? 0n;
  const phone = formatBdPhone(m.phone);
  const shownPhone = page === "bn" ? toBanglaDigits(phone) : phone;
  const rows: [string, string][] = [
    [t("receipt.member"), `${primaryName(m, locale)} · ${t("receipt.memberNo", { no: num(m.memberNo) })}`],
    [t("receipt.account"), `${a.productCode} #${num(a.accountNo)} · ${primaryName({ nameEn: a.productNameEn, nameBn: a.productNameBn }, locale)}`],
    [t("receipt.method"), `${txn.channel === "collector" ? t("passbook.collector") : t(`methods.${txn.paymentMethod}`)}${txn.paymentRef ? ` · ${txn.paymentRef}` : ""}`],
    [deposit ? t("receipt.takenBy") : t("receipt.paidByOfficer"), primaryName(txn.takenBy, locale)],
  ];

  return (
    <div className="receipt-page">
      <div className="receipt-tools no-print">
        <Link href={`/savings/accounts/${a.id}`} className="crumb">
          ← {tp("back")}
        </Link>
        <nav className="sort-toggle" aria-label={tp("language")}>
          {(["en", "bn"] as const).map((l) => (
            <Link key={l} href={`?lang=${l}`} aria-current={l === locale ? "true" : undefined} lang={l}>
              {l === "en" ? "English" : "বাংলা"}
            </Link>
          ))}
        </nav>
        <PrintButton label={tp("print")} />
      </div>

      <article className={`receipt ${txn.kind}${txn.reversed ? " reversed" : ""}`} lang={locale}>
        <header>
          <span className="receipt-logo" aria-hidden="true">
            ৳
          </span>
          <div>
            <strong className="receipt-somiti">{primaryName(r.somiti, locale)}</strong>
            <span>{deposit ? t("receipt.deposit") : t("receipt.withdrawal")}</span>
          </div>
        </header>
        <div className="receipt-meta">
          <strong>{deposit ? t("receipt.receiptNo", { no: num(txn.entryNo) }) : t("receipt.paymentNo", { no: num(txn.entryNo) })}</strong>
          <span>
            {formatDate(txn.businessDate, locale)} · {formatDateTime(txn.createdAt, locale)}
          </span>
        </div>
        {txn.reversed && <p className="receipt-void">{t("receipt.reversed")}</p>}

        <div className="receipt-amount">
          <span>{deposit ? t("receipt.amount") : t("receipt.paidOut")}</span>
          <strong>{taka(txn.amount)}</strong>
        </div>
        {fine > 0n && (
          <dl className="receipt-sum">
            <div>
              <dt>{t("receipt.fine")}</dt>
              <dd>{taka(fine)}</dd>
            </div>
            <div className="total">
              <dt>{t("receipt.total")}</dt>
              <dd>{taka(txn.amount + fine)}</dd>
            </div>
          </dl>
        )}

        <dl className="receipt-rows">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          <div className="balance">
            <dt>{t("receipt.balance")}</dt>
            <dd>{taka(txn.balanceAfter)}</dd>
          </div>
        </dl>

        <div className="receipt-signs">
          <span>{t("receipt.signOfficer")}</span>
          <span>{t("receipt.signMember")}</span>
        </div>
        <p className="receipt-footer">{t("receipt.footer")}</p>
      </article>

      <p className={`sms-state no-print ${r.sms ?? "none"}`}>
        <span aria-hidden="true">{r.sms === "sent" ? "✓" : r.sms === "failed" ? "!" : "✉"}</span>{" "}
        {r.sms ? tp(`sms.${r.sms}`, { phone: shownPhone }) : tp("sms.none")}
      </p>
    </div>
  );
}
