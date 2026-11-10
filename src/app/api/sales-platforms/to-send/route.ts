import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listOrdersToSend } from "@/lib/sales-platforms/to-send";

/** Sales › To send (SWS11): Shopify orders not yet fully sent, oldest first, with the total held. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  return json(await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listOrdersToSend(tx)));
});
