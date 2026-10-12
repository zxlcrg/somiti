import Link from "next/link";
import { getTranslations } from "next-intl/server";

/** "↩ Correct" on a transaction row, opening the correction request for its entry. */
export async function CorrectLink({ entryId }: { entryId: string }) {
  const t = await getTranslations("corrections");
  return (
    <Link href={`/corrections/new?entry=${entryId}`} className="correct-link" aria-label={t("rowLinkLabel")} title={t("rowLinkLabel")}>
      <span aria-hidden="true">↩</span> {t("rowLink")}
    </Link>
  );
}
