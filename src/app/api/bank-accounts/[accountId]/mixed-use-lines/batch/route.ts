import { json, readJson, route, withOrganisationRunner } from "@/lib/api/http";
import { startReviewBatch } from "@/lib/bank/mixed-use";
import { requireIdempotencyKey } from "@/lib/validation";

/**
 * POST: reviews several lines at once as a durable batch (#545, #547), e.g.
 * "Mark selected private". `actions`: each `{ lineId, decision, ... }` as
 * one review. Resumable from the Batches tab.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const outcome = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) =>
    startReviewBatch(run, { actions: body.actions, idempotencyKey, source: "ui", byAi: false }),
  );
  return json(outcome, { status: outcome.created ? 201 : 200 });
});
