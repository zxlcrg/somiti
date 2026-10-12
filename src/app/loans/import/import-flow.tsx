"use client";

import { startTransition, useActionState, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { importLoansAction, previewLoansAction, type ImportState, type PreviewState } from "./actions";

const COLUMNS = ["member_no", "phone", "product", "disbursed_on", "amount", "installments", "paid"] as const;

export function ImportFlow({ products, dateLabel }: { products: { code: string; name: string }[]; dateLabel: string }) {
  const t = useTranslations("loanImport");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const taka = (p: bigint | string) => formatTaka(BigInt(p), locale);
  const num = (n: number) => formatInteger(n, locale);

  const [state, preview, checking] = useActionState<PreviewState, FormData>(previewLoansAction, {});
  const [done, submit, importing] = useActionState<ImportState, FormData>(importLoansAction, {});
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(done);
  if (seen !== done) {
    setSeen(done);
    setConfirming(false);
  }
  const uploadRef = useRef<HTMLFormElement>(null);

  const p = state.preview;
  const blocked = !p || p.headerErrors.length > 0 || p.errors.length > 0 || p.rowCount === 0;

  return (
    <div className="opening-flow">
      <ol className="opening-steps">
        <li className="opening-step s1">
          <span className="step-no" aria-hidden="true">{num(1)}</span>
          <div>
            <h2>{t("steps.download")}</h2>
            <p className="muted">{t("steps.downloadBody")}</p>
            <a href="/loans/import/template" className="btn primary small" download>
              <span aria-hidden="true">⬇</span> {t("template")}
            </a>
          </div>
        </li>
        <li className="opening-step s2">
          <span className="step-no" aria-hidden="true">{num(2)}</span>
          <div>
            <h2>{t("steps.fill")}</h2>
            <p className="muted">{t("steps.fillBody")}</p>
          </div>
        </li>
        <li className="opening-step s3">
          <span className="step-no" aria-hidden="true">{num(3)}</span>
          <div>
            <h2>{t("steps.upload")}</h2>
            <p className="muted">{t("steps.uploadBody")}</p>
          </div>
        </li>
      </ol>

      <details className="column-guide">
        <summary>{t("guide.title")}</summary>
        <div className="table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>{t("guide.column")}</th>
                <th>{t("guide.what")}</th>
                <th>{t("guide.example")}</th>
              </tr>
            </thead>
            <tbody>
              {COLUMNS.map((c) => (
                <tr key={c}>
                  <td>
                    <code>{c}</code>
                  </td>
                  <td>
                    {t(`guide.${c}`)}
                    {c === "product" && products.length > 0 && (
                      <small className="muted guide-codes">
                        {products.map((pr) => (
                          <span key={pr.code}>
                            <code>{pr.code}</code> {pr.name}
                          </span>
                        ))}
                      </small>
                    )}
                  </td>
                  <td className="muted">{t(`guide.${c}Example`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <form
        ref={uploadRef}
        className={`drop-zone${checking ? " busy" : ""}${state.fileName ? " has-file" : ""}`}
        onSubmit={(ev) => {
          ev.preventDefault();
          const data = new FormData(ev.currentTarget);
          startTransition(() => preview(data));
        }}
      >
        <input
          id="sheet"
          name="sheet"
          type="file"
          accept=".csv,text/csv"
          aria-describedby="sheet-hint"
          onChange={(ev) => {
            if (ev.currentTarget.files?.length) uploadRef.current?.requestSubmit();
          }}
        />
        <span className="drop-icon" aria-hidden="true">
          {checking ? <span className="spinner" /> : "📄"}
        </span>
        <label htmlFor="sheet">
          <strong>{state.fileName && !checking ? state.fileName : checking ? t("checking") : t("drop")}</strong>
          <small id="sheet-hint" className="muted">
            {state.fileName && !checking ? t("dropAgain") : t("dropHint")}
          </small>
        </label>
      </form>
      {state.error && (
        <p className="form-error" role="alert" key={state.attempt}>
          {t(`uploadErrors.${state.error}`)}
        </p>
      )}

      {p && p.headerErrors.length > 0 && (
        <section className="opening-problems" role="alert">
          <h2>
            <span aria-hidden="true">⚠</span> {t("headerProblems")}
          </h2>
          <ul>
            {p.headerErrors.map((e, i) => (
              <li key={i}>{t(`headerErrors.${e.code}`, { column: "column" in e ? e.column : "", max: "max" in e ? num(e.max) : "" })}</li>
            ))}
          </ul>
        </section>
      )}

      {p && p.headerErrors.length === 0 && (
        <>
          <section className="stat-row opening-tiles" aria-label={t("summary")}>
            <div className="stat-tile tone-a">
              <span>{t("tiles.loans")}</span>
              <strong>{num(p.totals.loans)}</strong>
            </div>
            <div className="stat-tile tone-b">
              <span>{t("tiles.principalLeft")}</span>
              <strong>{taka(p.totals.principalLeft)}</strong>
            </div>
            <div className="stat-tile tone-c">
              <span>{t("tiles.chargeLeft")}</span>
              <strong>{taka(p.totals.chargeLeft)}</strong>
            </div>
            <div className={`stat-tile ${p.errors.length ? "tone-bad" : p.totals.overdueLoans ? "tone-warn" : "tone-good"}`}>
              <span>{p.errors.length ? t("tiles.problems") : t("tiles.late")}</span>
              <strong>{p.errors.length ? num(p.errors.length) : p.totals.overdueLoans ? num(p.totals.overdueLoans) : "✓"}</strong>
            </div>
          </section>

          {p.errors.length > 0 && (
            <section className="opening-problems" role="alert">
              <h2>
                <span aria-hidden="true">⚠</span> {t("rowProblems", { count: p.errors.length, n: num(p.errors.length) })}
              </h2>
              <p className="muted">{t("rowProblemsBody")}</p>
              <ul>
                {p.errors.map((e, i) => (
                  <li key={i}>
                    <span className="line-no">{t("line", { n: num(e.line) })}</span> {e.column && <code>{e.column}</code>} {t(`rowErrors.${e.code}`)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.rows.length > 0 && (
            <section className="opening-card">
              <h2>{t("rowsTitle")}</h2>
              <p className="muted">{t("rowsBody")}</p>
              <div className="table-wrap">
                <table className="ledger-table opening-table">
                  <thead>
                    <tr>
                      <th className="num">{t("cols.line")}</th>
                      <th>{t("cols.member")}</th>
                      <th>{t("cols.loan")}</th>
                      <th className="num">{t("cols.paid")}</th>
                      <th className="num">{t("cols.left")}</th>
                      <th>{t("cols.next")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r) => (
                      <tr key={r.line}>
                        <td className="num muted">{num(r.line)}</td>
                        <td>
                          <strong>{(locale === "bn" ? r.nameBn || r.nameEn : r.nameEn || r.nameBn) ?? ""}</strong>
                          <small className="muted">{t("memberNo", { no: num(r.memberNo) })}</small>
                        </td>
                        <td>
                          <strong className="nowrap">
                            {r.productCode} · {taka(r.amount)}
                          </strong>
                          <small className="muted">{t("given", { date: formatDate(r.disbursedOn, locale), n: num(r.installments) })}</small>
                        </td>
                        <td className="num">{taka(r.paid)}</td>
                        <td className="num">
                          <strong>{taka(r.principalLeft)}</strong>
                          <small className="muted">{t("leftNote", { count: r.left, n: num(r.left), charge: taka(r.chargeLeft) })}</small>
                        </td>
                        <td>
                          <span className="nowrap">{formatDate(r.nextDue, locale)}</span>
                          {r.overdue > 0 && <span className="chip warn">{t("lateChip", { count: r.overdue, n: num(r.overdue) })}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.rowCount > p.rows.length && <p className="muted small-note">{t("moreRows", { n: num(p.rowCount - p.rows.length) })}</p>}
            </section>
          )}

          {!blocked && (
            <form
              className="opening-card opening-confirm"
              noValidate
              onSubmit={(ev) => {
                ev.preventDefault();
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                const data = new FormData(ev.currentTarget);
                startTransition(() => submit(data));
              }}
            >
              <input type="hidden" name="csv" value={state.csv ?? ""} />
              <input type="hidden" name="batchKey" value={state.batchKey ?? ""} />
              <h2>{t("postTitle")}</h2>
              <p className="muted">{t("postBody", { amount: taka(p.totals.principalLeft), date: dateLabel })}</p>
              {p.totals.overdueLoans > 0 && <p className="muted small-note">{t("lateNote")}</p>}

              {done.error && (
                <p className="form-error" role="alert" key={done.attempt}>
                  {t(`importErrors.${done.error}`)}
                </p>
              )}
              {confirming ? (
                <div className="confirm-close" role="alertdialog" aria-labelledby="confirm-import-title">
                  <strong id="confirm-import-title">{t("confirmTitle", { loans: t("loanCount", { count: p.totals.loans, n: num(p.totals.loans) }) })}</strong>
                  <p>{t("confirmBody", { date: dateLabel })}</p>
                  <div className="confirm-actions">
                    <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={importing}>
                      {t("back")}
                    </button>
                    <button className="btn primary" disabled={importing} autoFocus>
                      {importing ? (
                        <>
                          <span className="spinner" aria-hidden="true" /> {t("importing")}
                        </>
                      ) : (
                        t("confirm")
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn primary block">
                  <span aria-hidden="true">📥</span> {t("import", { loans: t("loanCount", { count: p.totals.loans, n: num(p.totals.loans) }) })}
                </button>
              )}
            </form>
          )}
        </>
      )}
    </div>
  );
}
