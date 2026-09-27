import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { calculateGstReturn } from "@/lib/reports/gst-return";

/**
 * GET: the GST return (boxes 5-15, GST on transactions and the lines in each
 * box) for periodStart-periodEnd, with no adjustments. Nothing is stored.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    calculateGstReturn(tx, { periodStart: params.get("periodStart"), periodEnd: params.get("periodEnd") }),
  );
  return json(report);
});

/**
 * POST: works the return out with Box 9 and Box 13 adjustments
 * (`adjustments: [{ box: "9" | "13", description, amount }]`). Nothing is
 * stored; filing is POST /api/gst-returns.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    calculateGstReturn(tx, { periodStart: body.periodStart, periodEnd: body.periodEnd, adjustments: body.adjustments }),
  );
  return json(report);
});
