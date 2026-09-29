import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deletePurchaseOrder, getPurchaseOrder, updatePurchaseOrder } from "@/lib/purchase-orders/service";

type Context = { params: Promise<{ purchaseOrderId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  const purchaseOrder = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) =>
    getPurchaseOrder(tx, purchaseOrderId),
  );
  return json({ purchaseOrder });
});

/** Edits a draft purchase order. Fields left out keep their values; `lines` replaces every line. */
export const PATCH = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  const body = await readJson(request);
  const purchaseOrder = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updatePurchaseOrder(tx, purchaseOrderId, {
      contactId: body.contactId,
      orderDate: body.orderDate,
      deliveryDate: body.deliveryDate,
      deliveryAddress: body.deliveryAddress,
      deliveryInstructions: body.deliveryInstructions,
      reference: body.reference,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json({ purchaseOrder });
});

/** Deletes a draft purchase order. Approved ones are cancelled instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { purchaseOrderId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deletePurchaseOrder(tx, purchaseOrderId));
  return json({ ok: true });
});
