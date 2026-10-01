import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { cancelSalesOrder } from "@/lib/sales-orders/service";

type Context = { params: Promise<{ salesOrderId: string }> };

/** Cancels an approved sales order that has no invoices other than voided ones. */
export const POST = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    cancelSalesOrder(tx, salesOrderId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
