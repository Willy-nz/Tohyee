import { json, readJson, route, withOrganisation, withOrganisationRunner } from "@/lib/api/http";
import { planUnreconcile, startUnreconcileBatch } from "@/lib/bank/batches";
import { requireIdempotencyKey } from "@/lib/validation";

/**
 * POST: "Unreconcile selected" (#547, decision 1275). Without `previewHash`,
 * what it will do (nothing changes). With the preview's hash, the lines are
 * unreconciled as a batch, each as the Unreconcile button does (BK11):
 * nothing is posted or voided.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  if (body.previewHash == null || body.previewHash === "") {
    const plan = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => planUnreconcile(tx, body.lineIds));
    return json({ plan });
  }
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const outcome = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) =>
    startUnreconcileBatch(run, { lineIds: body.lineIds, previewHash: body.previewHash, idempotencyKey, source: "ui" }),
  );
  return json(outcome, { status: outcome.created ? 201 : 200 });
});
