import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canRequestCorrections, correctionTarget } from "@/modules/corrections";
import { requireUser } from "../../auth";
import { pageLocale, voucherNo } from "../../books";
import { RequestForm } from "../correction-forms";
import { KIND_ICON, placeHref } from "../shared";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("corrections.new");
  return { title: t("title") };
}

export default async function NewCorrectionPage({ searchParams }: { searchParams: Promise<{ entry?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("corrections");
  if (!canRequestCorrections(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const { entry } = await searchParams;
  const target = entry ? await withTenant(getAppDb(), user.tenantId, (ctx) => correctionTarget(ctx, entry)) : undefined;

  return (
    <div className="corrections">
      <header className="page-head">
        <div>
          <Link href="/corrections" className="crumb">
            ← {t("title")}
          </Link>
          <h1>{t("new.title")}</h1>
          <p className="muted">{t("new.subtitle")}</p>
        </div>
      </header>
      {!target ? (
        <p className="notice">{t("new.notFound")}</p>
      ) : (
        <div className="correction-new">
          <section className={`correction-card target ${target.kind}`}>
            <div className="cc-head">
              <span className="cc-icon" aria-hidden="true">
                {KIND_ICON[target.kind]}
              </span>
              <span>
                <strong>{t(`kind.${target.kind}`)}</strong>
                <small className="muted">
                  {t("entryOn", { no: voucherNo(target.entryNo, locale), date: formatDate(target.businessDate, locale) })}
                </small>
              </span>
              <span className="cc-amount">{formatTaka(target.total, locale)}</span>
            </div>
            <dl className="cc-facts">
              <div>
                <dt>{t("member")}</dt>
                <dd>
                  <Link href={`/members/${target.member.id}`}>
                    {primaryName(target.member, locale)} · {voucherNo(target.member.memberNo, locale)}
                  </Link>
                </dd>
              </div>
              {target.account && (
                <div>
                  <dt>{t(target.loanId ? "loan" : "account")}</dt>
                  <dd>
                    <Link href={placeHref(target)}>
                      {target.account.code} {voucherNo(target.account.no, locale)}
                    </Link>
                  </dd>
                </div>
              )}
              <div>
                <dt>{t("recordedBy")}</dt>
                <dd>{primaryName(target.recordedBy, locale)}</dd>
              </div>
              {target.total !== target.amount && (
                <div>
                  <dt>{t("withFine")}</dt>
                  <dd>{formatTaka(target.total - target.amount, locale)}</dd>
                </div>
              )}
            </dl>
          </section>
          <section className="correction-card ask">
            {target.blocker ? (
              <>
                <p className="notice warn" role="status">
                  <span aria-hidden="true">⚠️</span> {t(`blocker.${target.blocker}`)}
                </p>
                <Link href={placeHref(target)} className="btn ghost block">
                  {t("back")}
                </Link>
              </>
            ) : (
              <>
                <h2>{t("new.what")}</h2>
                <p className="muted small-note">{t("new.explain")}</p>
                <RequestForm entryId={target.entryId} />
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
