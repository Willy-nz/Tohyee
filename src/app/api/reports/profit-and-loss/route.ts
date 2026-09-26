import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { profitAndLoss } from "@/lib/reports/financial";

/** Profit and loss between `from` and `to` (defaults: start of the financial year to today). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    profitAndLoss(tx, { from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
