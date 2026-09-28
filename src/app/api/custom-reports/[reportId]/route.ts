import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteCustomReport, getCustomReport, updateCustomReport } from "@/lib/reports/custom";

type Context = { params: Promise<{ reportId: string }> };

/** GET: the report and its figures (worked out now for a draft, as kept for a published copy). */
export const GET = route<Context>(async (request, context) => {
  const { reportId } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getCustomReport(tx, reportId));
  return json(result);
});

/** Saves a draft's whole layout. `version` is the one that was loaded; returns the new figures. */
export const PUT = route<Context>(async (request, context) => {
  const { reportId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateCustomReport(tx, reportId, { layout: body.layout, version: body.version }),
  );
  return json(result);
});

/** Deletes a draft. Published reports are archived instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { reportId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteCustomReport(tx, reportId));
  return json({ ok: true });
});
