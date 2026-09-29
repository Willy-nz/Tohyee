import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approvePurchaseOrder } from "@/lib/purchase-orders/service";

type Context = { params: Promise<{ purchaseOrderId: string }> };

/** Approves a draft: numbers it (PO-0001, no gaps) and locks it. Posts nothing. */
export const POST = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    approvePurchaseOrder(tx, purchaseOrderId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
