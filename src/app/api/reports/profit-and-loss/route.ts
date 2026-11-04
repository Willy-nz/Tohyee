import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { profitAndLoss, profitAndLossSplit } from "@/lib/reports/financial";
import { parseCompare, profitAndLossCompare } from "@/lib/reports/statement-compare";

/**
 * Profit and loss between `from` and `to` (defaults: start of the financial
 * year to today). With `splitBy` (a tracking category id), one column per
 * top-level value, "Not set" and the total (example TC7). With `compare`
 * (1-11 earlier periods, `compareBy` month, quarter or year), `total`, `ytd`
 * or `percent` (of trading income), several columns (RX1-RX4); the periods
 * run oldest first unless `order` is "newest_first" (decision 1366). Any of them
 * can be filtered to one tracking value (`trackingCategoryId`,
 * `trackingValueId`, or "unassigned"; RX5).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const splitBy = params.get("splitBy");
  const input = {
    from: params.get("from"),
    to: params.get("to"),
    trackingCategoryId: params.get("trackingCategoryId"),
    trackingValueId: params.get("trackingValueId"),
  };
  const compare = parseCompare({
    compare: params.get("compare"),
    compareBy: params.get("compareBy"),
    order: params.get("order"),
    total: params.get("total"),
    ytd: params.get("ytd"),
    percent: params.get("percent"),
  });
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx): Promise<unknown> =>
    splitBy ? profitAndLossSplit(tx, { ...input, categoryId: splitBy }) : compare ? profitAndLossCompare(tx, input, compare) : profitAndLoss(tx, input),
  );
  return json(report);
});
