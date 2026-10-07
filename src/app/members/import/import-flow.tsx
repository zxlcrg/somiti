"use client";

import { startTransition, useActionState, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatDate, formatInteger, formatTaka } from "@/lib/format";
import { parseTaka } from "@/lib/money";
import { formatBdPhone } from "@/lib/phone";
import { importSheetAction, previewSheetAction, type ImportState, type PreviewState } from "./actions";

/** Fixed hue order for product bars; a product keeps its colour by position in the sheet. */
const BAR_TONES = ["p1", "p2", "p3", "p4", "p5", "p6"];

export function ImportFlow({ products, sharePrice, dateLabel }: { products: { code: string; name: string }[]; sharePrice: string; dateLabel: string }) {
  const t = useTranslations("opening");
  const raw = useLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const taka = (p: bigint | string) => formatTaka(BigInt(p), locale);
  const num = (n: number) => formatInteger(n, locale);
  const nameOf = (code: string) => products.find((p) => p.code === code)?.name ?? code;

  const [state, preview, checking] = useActionState<PreviewState, FormData>(previewSheetAction, {});
  const [done, submit, importing] = useActionState<ImportState, FormData>(importSheetAction, {});
  const [cash, setCash] = useState("");
  const [bank, setBank] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [seen, setSeen] = useState(done);
  if (seen !== done) {
    setSeen(done);
    setConfirming(false);
  }
  const uploadRef = useRef<HTMLFormElement>(null);

  const p = state.preview;
  const blocked = !p || p.headerErrors.length > 0 || p.errors.length > 0 || p.rowCount === 0;
  const owed = p ? BigInt(p.totals.shareAmount) + BigInt(p.totals.savingsAmount) : 0n;
  const cashP = parseTaka(cash);
  const bankP = parseTaka(bank);
  const moneyIn = (cashP ?? 0n) + (bankP ?? 0n);
  const equity = moneyIn - owed;
  const maxBar = p ? Object.values(p.totals.savings).reduce((m, s) => (BigInt(s.amount) > m ? BigInt(s.amount) : m), 0n) : 0n;
  const errorAt = new Map((p?.errors ?? []).map((e) => [`${e.line}:${e.column}`, e.code]));
  const knownAt = new Map((p?.existingPhones ?? []).map((x) => [x.line, x.memberNo]));

  return (
    <div className="opening-flow">
      <ol className="opening-steps">
        <li className="opening-step s1">
          <span className="step-no" aria-hidden="true">{num(1)}</span>
          <div>
            <h2>{t("steps.download")}</h2>
            <p className="muted">{t("steps.downloadBody", { count: products.length })}</p>
            <a href="/members/import/template" className="btn primary small" download>
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
              {(["name_en", "name_bn", "phone", "admission_date", "shares"] as const).map((c) => (
                <tr key={c}>
                  <td>
                    <code>{c}</code>
                  </td>
                  <td>{t(`guide.${c}`, { price: taka(sharePrice) })}</td>
                  <td className="muted">{t(`guide.${c}Example`)}</td>
                </tr>
              ))}
              {products.map((pr) => (
                <tr key={pr.code}>
                  <td>
                    <code>{pr.code}</code>
                  </td>
                  <td>{t("guide.product", { name: pr.name })}</td>
                  <td className="muted">{t("guide.productExample")}</td>
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
              <span>{t("tiles.members")}</span>
              <strong>{num(p.totals.members)}</strong>
            </div>
            <div className="stat-tile tone-b">
              <span>{t("tiles.shares", { count: p.totals.shares, n: num(p.totals.shares) })}</span>
              <strong>{taka(p.totals.shareAmount)}</strong>
            </div>
            <div className="stat-tile tone-c">
              <span>{t("tiles.savings")}</span>
              <strong>{taka(p.totals.savingsAmount)}</strong>
            </div>
            <div className={`stat-tile ${p.errors.length ? "tone-bad" : "tone-good"}`}>
              <span>{t("tiles.problems")}</span>
              <strong>{p.errors.length ? num(p.errors.length) : "✓"}</strong>
            </div>
          </section>

          {p.productCodes.length > 0 && (
            <section className="opening-card">
              <h2>{t("byProduct")}</h2>
              <ul className="product-bars">
                {p.productCodes.map((code, i) => {
                  const s = p.totals.savings[code]!;
                  const width = maxBar > 0n ? Number((BigInt(s.amount) * 1000n) / maxBar) / 10 : 0;
                  return (
                    <li key={code} className={BAR_TONES[i % BAR_TONES.length]}>
                      <span className="bar-label">
                        <strong>{code}</strong> {nameOf(code)}
                        <small className="muted">{t("accounts", { count: s.accounts, n: num(s.accounts) })}</small>
                      </span>
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${Math.max(width, BigInt(s.amount) > 0n ? 2 : 0)}%` }} />
                      </span>
                      <strong className="bar-value">{taka(s.amount)}</strong>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {p.errors.length > 0 && (
            <section className="opening-problems" role="alert">
              <h2>
                <span aria-hidden="true">⚠</span> {t("rowProblems", { count: p.errors.length, n: num(p.errors.length) })}
              </h2>
              <p className="muted">{t("rowProblemsBody")}</p>
              <ul>
                {p.errors.map((e, i) => (
                  <li key={i}>
                    <span className="line-no">{t("line", { n: num(e.line) })}</span> <code>{e.column}</code> {t(`rowErrors.${e.code}`)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.existingPhones.length > 0 && (
            <section className="opening-warning">
              <span aria-hidden="true">👥</span>
              <p>{t("alreadyMembers", { count: p.existingPhones.length, n: num(p.existingPhones.length) })}</p>
            </section>
          )}

          {p.rows.length > 0 && (
            <section className="opening-card">
              <h2>{t("rowsTitle")}</h2>
              <div className="table-wrap">
                <table className="ledger-table opening-table">
                  <thead>
                    <tr>
                      <th className="num">{t("cols.line")}</th>
                      <th>{t("cols.member")}</th>
                      <th>{t("cols.phone")}</th>
                      <th className="num">{t("cols.shares")}</th>
                      {p.productCodes.map((c) => (
                        <th key={c} className="num">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r) => (
                      <tr key={r.line} className={knownAt.has(r.line) ? "known" : undefined}>
                        <td className="num muted">{num(r.line)}</td>
                        <td>
                          <strong>{(locale === "bn" ? r.nameBn || r.nameEn : r.nameEn || r.nameBn) ?? ""}</strong>
                          {knownAt.has(r.line) && <span className="chip warn">{t("known", { no: num(knownAt.get(r.line)!) })}</span>}
                          {r.admissionDate && <small className="muted">{t("since", { date: formatDate(r.admissionDate, locale) })}</small>}
                        </td>
                        <td className="nowrap">{formatBdPhone(r.phone)}</td>
                        <td className="num">{r.shares ? num(r.shares) : "—"}</td>
                        {p.productCodes.map((c) => (
                          <td key={c} className={`num${errorAt.has(`${r.line}:${c}`) ? " bad" : ""}`}>
                            {r.balances[c] !== undefined ? taka(r.balances[c]!) : "—"}
                          </td>
                        ))}
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
              <h2>{t("cashTitle")}</h2>
              <p className="muted">{t("cashBody", { date: dateLabel })}</p>
              <div className="cash-fields">
                <div className={`field${cash && cashP === null ? " has-error" : ""}`}>
                  <label htmlFor="cash">{t("cash")}</label>
                  <input id="cash" name="cash" inputMode="decimal" placeholder="0" value={cash} onChange={(e) => setCash(e.target.value)} />
                </div>
                <div className={`field${bank && bankP === null ? " has-error" : ""}`}>
                  <label htmlFor="bank">{t("bank")}</label>
                  <input id="bank" name="bank" inputMode="decimal" placeholder="0" value={bank} onChange={(e) => setBank(e.target.value)} />
                </div>
              </div>

              <div className="opening-sum">
                <div>
                  <span>{t("sum.in")}</span>
                  <strong>{taka(moneyIn)}</strong>
                </div>
                <div>
                  <span>{t("sum.owed")}</span>
                  <strong>{taka(owed)}</strong>
                </div>
                <div className={equity < 0n ? "neg" : "pos"}>
                  <span>{t("sum.equity")}</span>
                  <strong>{taka(equity)}</strong>
                </div>
              </div>
              <p className="muted small-note">{t("equityNote")}</p>

              {done.error && (
                <p className="form-error" role="alert" key={done.attempt}>
                  {t(`importErrors.${done.error}`)}
                </p>
              )}
              {confirming ? (
                <div className="confirm-close" role="alertdialog" aria-labelledby="confirm-import-title">
                  <strong id="confirm-import-title">{t("confirmTitle", { count: p.totals.members, n: num(p.totals.members) })}</strong>
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
                <button className="btn primary block" disabled={(cash !== "" && cashP === null) || (bank !== "" && bankP === null)}>
                  <span aria-hidden="true">📥</span> {t("import", { count: p.totals.members, n: num(p.totals.members) })}
                </button>
              )}
            </form>
          )}
        </>
      )}
    </div>
  );
}
