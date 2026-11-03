import { json, readJson, route, withOrganisationRunner } from "@/lib/api/http";
import { resumeBankBatch } from "@/lib/bank/batches";

type Context = { params: Promise<{ batchId: string }> };

/**
 * POST: resumes a batch (#547, decision 1274): its pending and
 * outcome-unknown actions, and with `retryFailed` its refused ones, each with
 * its original key and fields. A bookkeeper can resume anyone's batch,
 * an AI's included; the history shows them as the one who did it.
 */
export const POST = route<Context>(async (request, context) => {
  const { batchId } = await context.params;
  const body = await readJson(request);
  const outcome = await withOrganisationRunner(request, body.organisationId, "bookkeeper", (run) =>
    resumeBankBatch(run, batchId, { retryFailed: body.retryFailed === true }),
  );
  return json(outcome, outcome.retryAfterSeconds ? { headers: { "retry-after": String(outcome.retryAfterSeconds) } } : {});
});
