import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { closePurchaseOrder } from "@/lib/purchase-orders/service";

type Context = { params: Promise<{ purchaseOrderId: string }> };

/** Closes the rest of an approved purchase order with no draft bills (PO10, decision 281). */
export const POST = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    closePurchaseOrder(tx, purchaseOrderId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
