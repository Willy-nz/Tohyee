import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { invoiceSalesOrder } from "@/lib/sales-orders/service";

type Context = { params: Promise<{ salesOrderId: string }> };

/**
 * Makes a draft invoice from an approved sales order: what's left on each
 * line, or the quantities in `lines` ([{ salesOrderLineId, quantity }]).
 */
export const POST = route<Context>(async (request, context) => {
  const { salesOrderId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    invoiceSalesOrder(tx, salesOrderId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate,
      exchangeRate: body.exchangeRate,
      lines: body.lines,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
