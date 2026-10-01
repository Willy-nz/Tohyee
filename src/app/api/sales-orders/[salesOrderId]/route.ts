import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteSalesOrder, getSalesOrder, updateSalesOrder } from "@/lib/sales-orders/service";

type Context = { params: Promise<{ salesOrderId: string }> };

/** A sales order with what's been invoiced on each line, and its invoices. */
export const GET = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  const salesOrder = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getSalesOrder(tx, salesOrderId));
  return json({ salesOrder });
});

/** Edits a draft sales order. Fields left out keep their values; `lines` replaces every line. */
export const PATCH = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  const body = await readJson(request);
  const salesOrder = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateSalesOrder(tx, salesOrderId, {
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
  return json({ salesOrder });
});

/** Deletes a draft sales order. Approved ones are closed or cancelled instead. */
export const DELETE = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteSalesOrder(tx, salesOrderId));
  return json({ ok: true });
});
