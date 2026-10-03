import { randomUUID } from "node:crypto";
import { withTenant, type Db } from "@/db/client";
import { appUser, branch, ledgerAccount, tenant, userRole } from "@/db/schema";
import { fiscalYearContaining, type IsoDate } from "@/lib/dates";
import type { Locale } from "@/i18n/config";
import { recordAudit } from "@/modules/audit/log";
import { DEFAULT_CHART, openFiscalPeriod } from "@/modules/ledger";

export interface CreateTenantInput {
  slug: string;
  nameEn?: string;
  nameBn?: string;
  defaultLocale?: Locale;
  /** First business date; usually go-live day. */
  businessDate: IsoDate;
  fiscalYearStartMonth?: number;
  admin: { nameEn?: string; nameBn?: string; phone: string };
}

export interface CreatedTenant {
  tenantId: string;
  branchId: string;
  adminUserId: string;
  fiscalPeriodId: string;
}

/**
 * Sets up a new somiti in one transaction: the tenant row, a main branch,
 * the first admin user, the default chart of accounts and the fiscal year
 * containing the first business date.
 */
export async function createTenant(db: Db, input: CreateTenantInput): Promise<CreatedTenant> {
  const tenantId = randomUUID();
  const fiscalYearStartMonth = input.fiscalYearStartMonth ?? 7;

  return withTenant(db, tenantId, async (ctx) => {
    const { tx } = ctx;
    await tx.insert(tenant).values({
      id: tenantId,
      slug: input.slug,
      nameEn: input.nameEn,
      nameBn: input.nameBn,
      defaultLocale: input.defaultLocale ?? "en",
      fiscalYearStartMonth,
      businessDate: input.businessDate,
    });

    const [mainBranch] = await tx
      .insert(branch)
      .values({ tenantId, code: "MAIN", nameEn: "Main", nameBn: "প্রধান" })
      .returning({ id: branch.id });

    const [admin] = await tx
      .insert(appUser)
      .values({ tenantId, branchId: mainBranch!.id, ...input.admin })
      .returning({ id: appUser.id });
    await tx.insert(userRole).values({ tenantId, userId: admin!.id, role: "admin" });

    const idsByCode = new Map<string, string>();
    for (const account of DEFAULT_CHART) idsByCode.set(account.code, randomUUID());
    await tx.insert(ledgerAccount).values(
      DEFAULT_CHART.map((a) => ({
        id: idsByCode.get(a.code)!,
        tenantId,
        code: a.code,
        nameEn: a.nameEn,
        nameBn: a.nameBn,
        type: a.type,
        parentId: a.parent ? idsByCode.get(a.parent)! : null,
        systemKey: a.systemKey ?? null,
        isPostable: !a.header,
      })),
    );

    const year = fiscalYearContaining(input.businessDate, fiscalYearStartMonth);
    const fiscalPeriodId = await openFiscalPeriod(ctx, { ...year, openedBy: admin!.id });

    await recordAudit(ctx, {
      actorUserId: admin!.id,
      action: "tenant.create",
      entityType: "tenant",
      entityId: tenantId,
      after: { slug: input.slug, businessDate: input.businessDate },
    });

    return { tenantId, branchId: mainBranch!.id, adminUserId: admin!.id, fiscalPeriodId };
  });
}
