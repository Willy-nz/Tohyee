import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveSalesOrder } from "@/lib/sales-orders/service";

type Context = { params: Promise<{ salesOrderId: string }> };

/** Approves a draft: numbers it (SO-0001, no gaps) and locks it. Posts nothing. */
export const POST = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    approveSalesOrder(tx, salesOrderId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
