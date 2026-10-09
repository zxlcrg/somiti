import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getAppDb, withTenant } from "@/db/client";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { primaryName } from "@/lib/names";
import { canViewMembers } from "@/modules/members";
import { depositChannel } from "@/modules/savings";
import { collectionSheet } from "@/modules/sheet";
import { requireUser } from "../auth";
import { pageLocale } from "../books";
import { PrintButton } from "./print-button";
import { SheetForm, type SheetRow } from "./sheet-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("sheet");
  return { title: t("title") };
}

/** The day's collection sheet: who owes what, what is taken, and a place to enter a filled-in paper sheet. */
export default async function CollectionSheetPage({ searchParams }: { searchParams: Promise<{ recorded?: string; amount?: string; fines?: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("sheet");
  if (!canViewMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const locale = await pageLocale();
  const sheet = await withTenant(getAppDb(), user.tenantId, (ctx) => collectionSheet(ctx));
  const { recorded, amount, fines } = await searchParams;
  const taka = (p: bigint) => formatTaka(p, locale);
  const num = (n: number) => formatInteger(n, locale);
  const channel = depositChannel(user.roles);
  const expected = sheet.totals.due + sheet.totals.fine;
  const progress = expected + sheet.totals.paidToday > 0n ? Number((sheet.totals.paidToday * 1000n) / (expected + sheet.totals.paidToday)) / 10 : 0;
  const count = Number(recorded) || 0;
  const big = (v: string | undefined) => (v && /^\d+$/.test(v) ? BigInt(v) : 0n);

  const rows: SheetRow[] = sheet.members.map((m) => ({
    member: { id: m.id, memberNo: m.memberNo, nameEn: m.nameEn, nameBn: m.nameBn, phone: m.phone, photoVersion: m.photoVersion },
    lines: m.lines.map((l) => ({
      key: `${l.kind === "savings" ? "s" : "l"}:${l.id}`,
      kind: l.kind,
      id: l.id,
      no: l.no,
      productCode: l.productCode,
      due: l.due.toString(),
      fine: l.fine.toString(),
      late: l.late,
      paidToday: l.paidToday.toString(),
      installment: l.installment?.toString() ?? null,
    })),
  }));

  return (
    <div className="sheet-page">
      <header className="page-head">
        <div>
          <h1>
            <span aria-hidden="true">🗒️</span> {t("title")}
          </h1>
          <p className="muted">{t("subtitle", { date: formatDate(sheet.date, locale) })}</p>
        </div>
        <div className="head-actions no-print">
          <PrintButton label={t("print")} />
        </div>
      </header>

      <div className="print-only print-head">
        <strong>{primaryName(user.somiti, locale)}</strong>
        <span>
          {t("title")} · {formatDate(sheet.date, locale)}
        </span>
        <span>{t("printCollector")} ______________________</span>
      </div>

      {count > 0 && (
        <p className="celebrate no-print" role="status">
          <span aria-hidden="true">✅</span>{" "}
          {t("recorded", { count, n: num(count), amount: taka(big(amount)) })}
          {big(fines) > 0n && ` ${t("recordedFines", { fines: taka(big(fines)) })}`}
        </p>
      )}

      <section className="sheet-summary no-print" aria-label={t("summary")}>
        <div className="sum-tile s-due">
          <span>{t("dueToday")}</span>
          <strong className="money-figure">{taka(sheet.totals.due)}</strong>
          <small>{sheet.totals.fine > 0n ? t("plusFines", { fines: taka(sheet.totals.fine) }) : t("noFines")}</small>
        </div>
        <div className="sum-tile s-taken">
          <span>{t("takenToday")}</span>
          <strong className="money-figure">{taka(sheet.totals.paidToday)}</strong>
          <small>{t("finesIncluded")}</small>
        </div>
        <div className="sum-tile s-people">
          <span>{t("toVisit")}</span>
          <strong>{num(sheet.totals.members)}</strong>
          <small>{t("lines", { count: sheet.totals.lines, n: num(sheet.totals.lines) })}</small>
        </div>
        <div className="sheet-progress" role="img" aria-label={t("progress", { pct: num(Math.round(progress)) })}>
          <span style={{ width: `${progress}%` }} />
          <small>{t("progress", { pct: num(Math.round(progress)) })}</small>
        </div>
      </section>

      {rows.length === 0 ? (
        <section className="loan-card all-clear">
          <span aria-hidden="true">🌿</span>
          <h2>{t("none")}</h2>
          <p className="muted">{t("noneHint")}</p>
        </section>
      ) : (
        <SheetForm rows={rows} sheetKey={randomUUID()} channel={channel} locale={locale} />
      )}

      <p className="muted small-note no-print">{t("howItWorks")}</p>
    </div>
  );
}
