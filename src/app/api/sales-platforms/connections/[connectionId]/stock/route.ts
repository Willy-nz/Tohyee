import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { connectionStock } from "@/lib/sales-platforms/service";

type Context = { params: Promise<{ connectionId: string }> };

/** Shopify's stock beside Tohyee's for matched items (SPD2). Read only; viewers can read it. */
export const GET = route<Context>(async (request, context) => {
  const { connectionId } = await context.params;
  const params = searchParams(request);
  const stock = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => connectionStock(tx, connectionId));
  return json(stock);
});
