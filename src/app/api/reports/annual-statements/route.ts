import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { buildFinancialStatements } from "@/lib/reports/financial-statements";

/** GET: the year's annual financial statements as the report shows them (FS4-FS7): the same lines as the PDF. Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    buildFinancialStatements(tx, { yearEnd: params.get("yearEnd") }),
  );
  return json(report);
});
