import { toCsv } from "@/lib/csv";
import { loanImportTemplate } from "@/modules/loans";
import { canImportOpening } from "@/modules/opening";
import { getCurrentUser } from "../../../auth";

/** The blank sheet of running loans. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!canImportOpening(user.roles)) return new Response(null, { status: 403 });
  return new Response(toCsv(loanImportTemplate()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="somiti-running-loans.csv"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
