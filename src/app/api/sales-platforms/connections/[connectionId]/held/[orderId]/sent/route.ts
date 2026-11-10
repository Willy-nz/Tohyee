import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { markHeldOrderSent } from "@/lib/sales-platforms/when-sent";

type Context = { params: Promise<{ connectionId: string; orderId: string }> };

/**
 * Mark as sent (SWS10, decision 1570): an order Shopify never marked
 * fulfilled counts as sent on `sentOn`, as a fulfilment would (bookkeepers).
 */
export const POST = route<Context>(async (request, context) => {
  const { connectionId, orderId } = await context.params;
  const body = await readJson(request);
  const order = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => markHeldOrderSent(tx, connectionId, orderId, body.sentOn));
  return json({ order });
});
