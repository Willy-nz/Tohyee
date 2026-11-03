import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { trialBalance } from "@/lib/reports/financial";

/** Trial balance as at a date (defaults to today), optionally for one tracking value (RX5). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    trialBalance(tx, { asAt: params.get("asAt"), trackingCategoryId: params.get("trackingCategoryId"), trackingValueId: params.get("trackingValueId") }),
  );
  return json(report);
});
