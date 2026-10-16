import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { buildIncomeTax } from "@/lib/tax/income/service";

/**
 * GET: the income tax workspace for an income year (ITX1-ITX10): taxable
 * income, provisional tax, end-of-year tax and due dates. Owners and admins
 * only (decision 545): a sole trader's other income is personal. Read-only.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "admin", (tx) => buildIncomeTax(tx, { incomeYear: params.get("incomeYear") }));
  return json({ report });
});
