import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { acceptQuoteAsSalesOrder } from "@/lib/quotes/service";

type Context = { params: Promise<{ quoteId: string }> };

/** Accepts a finalised quote as a sales order: makes a draft sales order carrying its lines, linked both ways. */
export const POST = route<Context>(async (request, context) => {
  const { quoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    acceptQuoteAsSalesOrder(tx, quoteId, { source: body.source, idempotencyKey: body.idempotencyKey, orderDate: body.orderDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
