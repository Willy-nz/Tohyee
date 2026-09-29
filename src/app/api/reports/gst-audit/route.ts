import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { gstAuditReport } from "@/lib/reports/gst-audit";

/**
 * GET: the GST audit report (examples GA1-GA4): the documents behind each
 * GST return box for periodStart-periodEnd, or for a filed return
 * (`gstReturnId`) as it was filed. Nothing is stored.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    gstAuditReport(tx, { periodStart: params.get("periodStart"), periodEnd: params.get("periodEnd"), gstReturnId: params.get("gstReturnId") }),
  );
  return json(report);
});

/** POST: the same with Box 9 and Box 13 adjustments (`adjustments: [{ box, description, amount }]`). Nothing is stored. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const report = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    gstAuditReport(tx, { periodStart: body.periodStart, periodEnd: body.periodEnd, adjustments: body.adjustments }),
  );
  return json(report);
});
