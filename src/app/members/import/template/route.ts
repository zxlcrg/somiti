import { getAppDb, withTenant } from "@/db/client";
import { toCsv } from "@/lib/csv";
import { canImportOpening, openingTemplateHeader } from "@/modules/opening";
import { listProducts } from "@/modules/savings";
import { getCurrentUser } from "../../../auth";

/** The blank opening-balance sheet, with a column for each active savings product. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!canImportOpening(user.roles)) return new Response(null, { status: 403 });
  const products = await withTenant(getAppDb(), user.tenantId, (ctx) => listProducts(ctx, { activeOnly: true }));
  return new Response(toCsv([openingTemplateHeader(products)]), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="somiti-opening-balances.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
