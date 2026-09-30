import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { copyPurchaseOrderToBill } from "@/lib/purchase-orders/service";

type Context = { params: Promise<{ purchaseOrderId: string }> };

/** Copy to bill: makes a draft bill with what's left to bill on each line, linked back to the purchase order. */
export const POST = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    copyPurchaseOrderToBill(tx, purchaseOrderId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      billDate: body.billDate,
      dueDate: body.dueDate,
      supplierInvoiceNumber: body.supplierInvoiceNumber,
      exchangeRate: body.exchangeRate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
