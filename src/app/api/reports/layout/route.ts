import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { runDefaultLayout } from "@/lib/reports/report-layouts";

/**
 * The standard profit and loss or balance sheet in its default layout
 * (decision 1359), with the toolbar's dates, comparisons and tracking
 * filter. `{ layout: null }` when it has none.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const layout = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    runDefaultLayout(tx, {
      base: params.get("base"),
      from: params.get("from"),
      to: params.get("to"),
      asAt: params.get("asAt"),
      compare: params.get("compare"),
      compareBy: params.get("compareBy"),
      order: params.get("order"),
      ytd: params.get("ytd"),
      trackingCategoryId: params.get("trackingCategoryId"),
      trackingValueId: params.get("trackingValueId"),
    }),
  );
  return json({ layout });
});
