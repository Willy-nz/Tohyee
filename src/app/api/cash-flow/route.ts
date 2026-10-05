import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { cashFlowForecast } from "@/lib/cash-flow/forecast";

/**
 * GET: the cash flow forecast (CF1-CF9): `period` day, week or month,
 * `count` periods, `accountIds` (comma separated; all bank accounts by
 * default), `includeDrafts`, `includeOrders`. Viewers and above.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const forecast = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    cashFlowForecast(tx, {
      period: params.get("period"),
      count: params.get("count"),
      accountIds: params.get("accountIds"),
      includeDrafts: params.get("includeDrafts"),
      includeOrders: params.get("includeOrders"),
    }),
  );
  return json({ forecast });
});
