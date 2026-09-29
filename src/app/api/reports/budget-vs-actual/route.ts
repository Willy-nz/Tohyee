import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { budgetVsActual } from "@/lib/reports/budget-vs-actual";

/** Budget vs actual for whole months `from` to `to` (YYYY-MM) against `budgetId` (examples BU5, BU6). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    budgetVsActual(tx, { budgetId: params.get("budgetId"), from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
