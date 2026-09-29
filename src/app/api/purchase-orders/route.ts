import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createPurchaseOrder, listPurchaseOrders } from "@/lib/purchase-orders/service";

/** GET: newest first. Filters: status (draft|approved|billed|cancelled), contactId, beforeId. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listPurchaseOrders(tx, { status: params.get("status"), contactId: params.get("contactId"), beforeId: params.get("beforeId") }),
  );
  return json(result);
});

/** Saves a draft purchase order. Purchase orders post nothing. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createPurchaseOrder(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
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
  return json(result, { status: result.created ? 201 : 200 });
});
