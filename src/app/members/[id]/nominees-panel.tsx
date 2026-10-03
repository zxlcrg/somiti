import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { toBanglaDigits } from "@/lib/digits";
import { formatPercentBp } from "@/lib/format";
import { initial, primaryName, secondaryName } from "@/lib/names";
import { formatBdPhone } from "@/lib/phone";
import type { NomineeView } from "@/modules/members";
import { nomineeHue } from "../nominee-colors";

export async function NomineesPanel({
  nominees,
  memberId,
  memberName,
  locale,
  canEdit,
  notice,
}: {
  nominees: NomineeView[];
  memberId: string;
  memberName: string;
  locale: Locale;
  canEdit: boolean;
  notice?: "saved" | "unchanged";
}) {
  const t = await getTranslations("members.nominees");
  const tProfile = await getTranslations("members.profile");
  const digits = (s: string) => (locale === "bn" ? toBanglaDigits(s) : s);
  const editHref = `/members/${memberId}/nominees`;

  return (
    <section className="nominees" aria-labelledby="nominees-title">
      <header className="nominees-head">
        <div>
          <h2 id="nominees-title">{t("title")}</h2>
          <p className="muted">{t("subtitle", { name: memberName })}</p>
        </div>
        {canEdit && nominees.length > 0 && (
          <Link href={editHref} className="btn ghost small">
            ✎ {t("edit")}
          </Link>
        )}
      </header>

      {notice && (
        <p className="celebrate small" role="status">
          {notice === "saved" ? `✓ ${t("saved")}` : t("unchanged")}
        </p>
      )}

      {nominees.length === 0 ? (
        <div className="nominees-empty">
          <div className="share-bar empty" aria-hidden="true" />
          <strong>{t("none")}</strong>
          <p className="muted">{t("noneBody")}</p>
          {canEdit && (
            <Link href={editHref} className="btn primary small">
              ＋ {t("add")}
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="share-bar" role="img" aria-label={nominees.map((n) => `${primaryName(n, locale)} ${formatPercentBp(n.shareBp, locale)}`).join(", ")}>
            {nominees.map((n, i) => (
              <span
                key={n.id}
                style={{ "--h": nomineeHue(i), flexGrow: n.shareBp, animationDelay: `${i * 80}ms` } as React.CSSProperties}
              >
                {n.shareBp >= 1200 ? formatPercentBp(n.shareBp, locale) : ""}
              </span>
            ))}
          </div>
          <ul className="nominee-list">
            {nominees.map((n, i) => {
              const second = secondaryName(n, locale);
              const guardian = { nameEn: n.minorGuardianNameEn, nameBn: n.minorGuardianNameBn };
              return (
                <li key={n.id} className="nominee-card" style={{ "--h": nomineeHue(i) } as React.CSSProperties}>
                  <span className="nominee-dot" aria-hidden="true">
                    {initial(n, locale)}
                  </span>
                  <div className="nominee-body">
                    <div className="nominee-top">
                      <strong>{primaryName(n, locale)}</strong>
                      <span className="chip">{t(`relations.${n.relation}`)}</span>
                      {(guardian.nameEn || guardian.nameBn) && <span className="chip minor">{t("minor")}</span>}
                    </div>
                    {second && <span className="muted">{second}</span>}
                    <span className="nominee-meta">
                      {n.phone && <span>{digits(formatBdPhone(n.phone))}</span>}
                      {n.nidLast4 && <span>{tProfile("nid")} •••• {digits(n.nidLast4)}</span>}
                      {(guardian.nameEn || guardian.nameBn) && (
                        <span>
                          {t("guardian")}: {primaryName(guardian, locale)}
                        </span>
                      )}
                    </span>
                  </div>
                  <span className="nominee-share">
                    <small>{t("share")}</small>
                    {formatPercentBp(n.shareBp, locale)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
