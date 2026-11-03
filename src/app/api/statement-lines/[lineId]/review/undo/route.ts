import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { undoReview } from "@/lib/bank/mixed-use";

type Context = { params: Promise<{ lineId: string }> };

/** POST: undoes a line's review (MU9): what it posted is voided on the line's date, and the line goes back to review. */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    undoReview(tx, lineId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
