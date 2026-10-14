import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { changesInEquity } from "@/lib/reports/statements";

/** Statement of changes in equity for a period (defaults to the financial year to date). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    changesInEquity(tx, { from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
