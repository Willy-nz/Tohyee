import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { trialBalance } from "@/lib/reports/financial";

/** Trial balance as at a date (defaults to today). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    trialBalance(tx, { asAt: params.get("asAt") }),
  );
  return json(report);
});
