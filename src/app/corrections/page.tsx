import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatDateTime, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canApproveCorrections, canRequestCorrections, listCorrections } from "@/modules/corrections";
import { requireUser } from "../auth";
import { pageLocale, voucherNo } from "../books";
import { DecideForm } from "./correction-forms";
import { KIND_ICON } from "./shared";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("corrections");
  return { title: t("title") };
}

const DONE = ["request", "approve", "reject", "cancel"] as const;

export default async function CorrectionsPage({ searchParams }: { searchParams: Promise<{ done?: string; id?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("corrections");
  if (!canRequestCorrections(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const search = await searchParams;
  const done = DONE.find((d) => d === search.done);
  const list = await withTenant(getAppDb(), user.tenantId, (ctx) => listCorrections(ctx, { limit: 60 }));
  const canDecide = canApproveCorrections(user.roles);
  const taka = (p: bigint) => formatTaka(p, locale);
  const pending = list.filter((c) => c.status === "pending");
  const decided = list.filter((c) => c.status !== "pending");
  const fresh = list.find((c) => c.id === search.id);

  return (
    <div className="corrections">
      <header className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p className="muted">{t("subtitle")}</p>
        </div>
      </header>

      {done && (
        <p className={`celebrate${done === "approve" ? "" : " soft"}`} role="status">
          {t(`done.${done}`, { no: fresh?.reversalNo != null ? voucherNo(fresh.reversalNo, locale) : "" })}
        </p>
      )}

      <section className="how-card">
        <h2>{t("how.title")}</h2>
        <ol>
          <li>{t("how.find")}</li>
          <li>{t("how.ask")}</li>
          <li>{t("how.approve")}</li>
          <li>{t("how.redo")}</li>
        </ol>
      </section>

      <h2 className="section-title">
        {t("pendingTitle")} {pending.length > 0 && <span className="count-badge">{pending.length}</span>}
      </h2>
      {pending.length === 0 ? (
        <p className="muted empty-line">{t("nonePending")}</p>
      ) : (
        <ul className="correction-list">
          {pending.map((c, i) => {
            const mine = c.requestedBy.id === user.userId;
            return (
              <li key={c.id} id={c.id} style={{ "--i": i } as React.CSSProperties} className={`correction-card pending${!mine && canDecide ? " needs-you" : ""}`}>
                <Head c={c} t={t} locale={locale} taka={taka} />
                <blockquote className="cc-reason">
                  <p>{c.reason}</p>
                  <footer className="muted">{t("askedBy", { name: primaryName(c.requestedBy, locale), date: formatDate(c.requestedOn, locale) })}</footer>
                </blockquote>
                <DecideForm correctionId={c.id} mine={mine} canDecide={canDecide} amount={taka(c.total)} />
              </li>
            );
          })}
        </ul>
      )}

      {decided.length > 0 && (
        <>
          <h2 className="section-title">{t("recentTitle")}</h2>
          <ul className="correction-list decided">
            {decided.map((c) => (
              <li key={c.id} id={c.id} className={`correction-card ${c.status}${c.id === fresh?.id ? " fresh" : ""}`}>
                <Head c={c} t={t} locale={locale} taka={taka} />
                <p className="cc-outcome">
                  <span className={`status-pill ${c.status}`}>{t(`status.${c.status}`)}</span>{" "}
                  <span className="muted">
                    {c.status === "approved" && c.reversalNo !== null
                      ? t("reversedAs", { no: voucherNo(c.reversalNo, locale), name: primaryName(c.decidedBy ?? { nameEn: null, nameBn: null }, locale) })
                      : c.decidedBy && c.decidedAt
                        ? t("decidedBy", { name: primaryName(c.decidedBy, locale), when: formatDateTime(c.decidedAt, locale) })
                        : null}
                  </span>
                </p>
                <p className="cc-why">
                  <span className="muted">{t("reasonLabel")}</span> {c.reason}
                </p>
                {c.decisionNote && (
                  <p className="cc-why">
                    <span className="muted">{t("noteLabel")}</span> {c.decisionNote}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Head({
  c,
  t,
  locale,
  taka,
}: {
  c: Awaited<ReturnType<typeof listCorrections>>[number];
  t: Awaited<ReturnType<typeof getTranslations<"corrections">>>;
  locale: Awaited<ReturnType<typeof pageLocale>>;
  taka: (p: bigint) => string;
}) {
  return (
    <div className="cc-head">
      <span className="cc-icon" aria-hidden="true">
        {KIND_ICON[c.kind]}
      </span>
      <span>
        <strong>{t(`kind.${c.kind}`)}</strong>
        <small className="muted">
          {c.member && (
            <>
              <Link href={`/members/${c.member.id}`}>
                {primaryName(c.member, locale)} · {voucherNo(c.member.memberNo, locale)}
              </Link>
              {" · "}
            </>
          )}
          {t("entryOn", { no: voucherNo(c.entryNo, locale), date: formatDate(c.entryDate, locale) })}
        </small>
      </span>
      <span className="cc-amount">{taka(c.total)}</span>
    </div>
  );
}
