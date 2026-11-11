import { json, readJson, route, withOrganisation, withOrganisationRunner } from "@/lib/api/http";
import { planRemoveAndRedo, startRemoveAndRedo } from "@/lib/bank/batches";
import { requireIdempotencyKey } from "@/lib/validation";

/**
 * POST: Remove & redo (BK45, decision 1574). Without `previewHash`, what it
 * will do (nothing changes). With the preview's hash, the lines are
 * unreconciled and what each created is voided on its date, as a batch.
 * `removePayments: true` voids payments the lines recorded too.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  if (body.previewHash == null || body.previewHash === "") {
    const plan = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => planRemoveAndRedo(tx, body.lineIds, { removePayments: body.removePayments }));
    return json({ plan });
  }
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const outcome = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) =>
    startRemoveAndRedo(run, { lineIds: body.lineIds, removePayments: body.removePayments, previewHash: body.previewHash, idempotencyKey, source: "ui" }),
  );
  return json(outcome, { status: outcome.created ? 201 : 200 });
});
