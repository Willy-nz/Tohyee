import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createCustomReport, listCustomReports } from "@/lib/reports/custom";

/** GET: custom reports, `view` = drafts (default), published or archived. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const reports = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listCustomReports(tx, params.get("view")));
  return json({ reports });
});

/** Starts a draft as a copy of a standard report (examples CR1, CR6): `base` is profit_and_loss or balance_sheet. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createCustomReport(tx, { source: body.source, idempotencyKey: body.idempotencyKey, base: body.base, periodEnd: body.periodEnd }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
