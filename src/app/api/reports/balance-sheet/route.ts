import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { balanceSheet } from "@/lib/reports/financial";

/** Balance sheet as at a date (defaults to today). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    balanceSheet(tx, { asAt: params.get("asAt") }),
  );
  return json(report);
});
