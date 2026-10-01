import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createSalesOrder, listSalesOrders } from "@/lib/sales-orders/service";

/** GET: newest first. Filters: status (draft|pending_billing|partly_billed|billed|closed|cancelled), contactId, beforeId. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSalesOrders(tx, { status: params.get("status"), contactId: params.get("contactId"), beforeId: params.get("beforeId") }),
  );
  return json(result);
});

/** Saves a draft sales order. Sales orders post nothing. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createSalesOrder(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      contactId: body.contactId,
      orderDate: body.orderDate,
      expectedDate: body.expectedDate,
      reference: body.reference,
      memo: body.memo,
      amountsMode: body.amountsMode,
      lines: body.lines,
      customFields: body.customFields,
      salespersonId: body.salespersonId,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
