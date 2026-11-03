import { json, readJson, route, withOrganisation, withOrganisationRunner } from "@/lib/api/http";
import { planBatchUndo, startBatchUndo } from "@/lib/bank/batches";
import { requireIdempotencyKey } from "@/lib/validation";

type Context = { params: Promise<{ batchId: string }> };

/**
 * POST: undoing a batch of reconciliations (#547, decision 1276). Without
 * `previewHash`, what it will do (nothing changes). With the preview's hash,
 * it's done as a batch of its own: each line unreconciled, with its
 * transfer's other side, and what the batch posted voided on the line's date.
 */
export const POST = route<Context>(async (request, context) => {
  const { batchId } = await context.params;
  const body = await readJson(request);
  if (body.previewHash == null || body.previewHash === "") {
    const plan = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => planBatchUndo(tx, batchId));
    return json({ plan });
  }
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const outcome = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) =>
    startBatchUndo(run, batchId, { previewHash: body.previewHash, idempotencyKey, source: "ui" }),
  );
  return json(outcome, { status: outcome.created ? 201 : 200 });
});
