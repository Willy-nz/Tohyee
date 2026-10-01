import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { closeSalesOrder } from "@/lib/sales-orders/service";

type Context = { params: Promise<{ salesOrderId: string }> };

/** Closes an approved sales order: nothing more will be invoiced on it. */
export const POST = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    closeSalesOrder(tx, salesOrderId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
