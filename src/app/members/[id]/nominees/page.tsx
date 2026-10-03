import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import { getAppDb, withTenant } from "@/db/client";
import { tenant } from "@/db/schema";
import { defaultLocale, isLocale } from "@/i18n/config";
import { primaryName } from "@/lib/names";
import { bpToPercentInput } from "@/lib/shares";
import { canManageMembers, getMember, listNominees } from "@/modules/members";
import { requireUser } from "../../../auth";
import { blankRow, type EditorRow } from "./editor-rows";
import { NomineeEditor } from "./nominee-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("members.nominees");
  return { title: t("title") };
}

export default async function NomineesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const t = await getTranslations("members");
  if (!canManageMembers(user.roles)) return <p className="notice">{t("noAccess")}</p>;
  const { id } = await params;

  const data = await withTenant(getAppDb(), user.tenantId, async (ctx) => {
    const member = await getMember(ctx, id);
    if (!member) return null;
    const [somiti] = await ctx.tx
      .select({ businessDate: tenant.businessDate })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId));
    return { member, nominees: await listNominees(ctx, member.id), businessDate: somiti!.businessDate };
  });
  if (!data) notFound();
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : defaultLocale;
  const name = primaryName(data.member, locale);

  if (data.member.status !== "active") {
    return (
      <div className="members">
        <p className="notice">{t("nominees.inactive")}</p>
      </div>
    );
  }

  const rows: EditorRow[] = data.nominees.length
    ? data.nominees.map((n) => ({
        key: n.id,
        id: n.id,
        nameEn: n.nameEn ?? "",
        nameBn: n.nameBn ?? "",
        relation: n.relation,
        phone: n.phone ? n.phone.replace(/^\+88/, "") : "",
        nid: "",
        nidLast4: n.nidLast4,
        dateOfBirth: n.dateOfBirth ?? "",
        minorGuardianNameEn: n.minorGuardianNameEn ?? "",
        minorGuardianNameBn: n.minorGuardianNameBn ?? "",
        share: bpToPercentInput(n.shareBp),
      }))
    : [blankRow("100")];

  return (
    <div className="members">
      <Link href={`/members/${id}`} className="crumb">
        ← {name}
      </Link>
      <header className="page-head">
        <div>
          <h1>{t("nominees.editor.title", { name })}</h1>
          <p className="muted">{t("nominees.editor.subtitle")}</p>
        </div>
      </header>
      <NomineeEditor memberId={id} initialRows={rows} businessDate={data.businessDate} />
    </div>
  );
}
