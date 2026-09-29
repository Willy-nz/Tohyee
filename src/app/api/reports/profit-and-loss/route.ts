import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { profitAndLoss, profitAndLossSplit } from "@/lib/reports/financial";

/**
 * Profit and loss between `from` and `to` (defaults: start of the financial
 * year to today). With `splitBy` (a tracking category id), one column per
 * top-level value, "Not set" and the total (example TC7).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const splitBy = params.get("splitBy");
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx): Promise<unknown> =>
    splitBy
      ? profitAndLossSplit(tx, { from: params.get("from"), to: params.get("to"), categoryId: splitBy })
      : profitAndLoss(tx, { from: params.get("from"), to: params.get("to") }),
  );
  return json(report);
});
