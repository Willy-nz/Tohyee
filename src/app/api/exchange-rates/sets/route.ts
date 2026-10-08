import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listRateSets, previewRateSet, uploadRateSet } from "@/lib/fx/sources";

/** GET: uploaded rate sets (#183, FX3), newest period first. Viewers and above. */
export const GET = route(async (request) => {
  const sets = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listRateSets(tx));
  return json({ sets });
});

/**
 * POST `{ name, periodStart, periodEnd, quoted, fileName, fileBase64,
 * idempotencyKey, replaceReason? }`: uploads a set (FX3, FX6). With
 * `preview: true` nothing is saved and the converted rates come back.
 * Bookkeepers, admins and owners.
 */
export const POST = route(async (request) => {
  // A 2 MB file is about 2.7 MB as base64.
  const body = await readJson(request, { maxBytes: 4 * 1024 * 1024 });
  if (body.preview === true) {
    const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewRateSet(tx, body));
    return json({ preview });
  }
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => uploadRateSet(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
