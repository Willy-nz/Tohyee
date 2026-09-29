import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { rollBackDepreciationRun } from "@/lib/fixed-assets/runs";

type Context = { params: Promise<{ runId: string }> };

/** Rolls back the latest run with the exact reversal on its date (FA5). Bookkeepers and above. */
export const POST = route<Context>(async (request, context) => {
  const { runId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    rollBackDepreciationRun(tx, runId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
