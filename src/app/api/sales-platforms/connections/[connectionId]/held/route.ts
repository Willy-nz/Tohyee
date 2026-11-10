import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listHeldOrders } from "@/lib/sales-platforms/when-sent";

type Context = { params: Promise<{ connectionId: string }> };

/** Shopify orders still holding something to be sent (sales when sent, SWS10), oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const params = searchParams(request);
  const orders = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listHeldOrders(tx, connectionId));
  return json({ orders });
});
