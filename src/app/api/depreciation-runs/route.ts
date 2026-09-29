import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listDepreciationRuns, previewDepreciationRun, runDepreciation } from "@/lib/fixed-assets/runs";

/** GET: runs, newest first; with `periodEnd`, what a run to that month end would post instead (FA3). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const periodEnd = params.get("periodEnd");
  if (periodEnd) {
    const preview = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => previewDepreciationRun(tx, periodEnd));
    return json({ preview });
  }
  const runs = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listDepreciationRuns(tx));
  return json({ runs });
});

/** Runs depreciation to `periodEnd`, posting one journal (FA3-FA6). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    runDepreciation(tx, { source: body.source, idempotencyKey: body.idempotencyKey, periodEnd: body.periodEnd }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
