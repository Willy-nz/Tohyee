import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { balanceSheet } from "@/lib/reports/financial";
import { balanceSheetCompare, parseCompare } from "@/lib/reports/statement-compare";

/**
 * Balance sheet as at a date (defaults to today), optionally for one
 * tracking value (`trackingCategoryId`, `trackingValueId` or "unassigned";
 * RX5) and compared with earlier dates (`compare` = 1-11, `compareBy` =
 * month, quarter or year; RX3), oldest first unless `order` is
 * "newest_first" (decision 1366).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const input = { asAt: params.get("asAt"), trackingCategoryId: params.get("trackingCategoryId"), trackingValueId: params.get("trackingValueId") };
  const compare = parseCompare({ compare: params.get("compare"), compareBy: params.get("compareBy"), order: params.get("order") });
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx): Promise<unknown> =>
    compare ? balanceSheetCompare(tx, input, compare) : balanceSheet(tx, input),
  );
  return json(report);
});
