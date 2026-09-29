import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { cancelPurchaseOrder } from "@/lib/purchase-orders/service";

type Context = { params: Promise<{ purchaseOrderId: string }> };

/** Cancels an approved purchase order that has no bills (other than voided ones). */
export const POST = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    cancelPurchaseOrder(tx, purchaseOrderId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
