import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { unreconcileStatementLine } from "@/lib/bank/reconcile";

type Context = { params: Promise<{ lineId: string }> };

/** Unreconciles a line. Nothing is posted or voided. */
export const POST = route<Context>(async (request, context) => {
  const { lineId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    unreconcileStatementLine(tx, lineId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
