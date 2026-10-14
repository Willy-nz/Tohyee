import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { undoPriceChange } from "@/lib/repeating/price-changes";

type Context = { params: Promise<{ priceChangeId: string }> };

/** Cancels what's waiting and puts back the old prices on lines still at the new ones (RP7). */
export const POST = route<Context>(async (request, context) => {
  const { priceChangeId } = await context.params;
  const body = await readJson(request);
  const priceChange = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => undoPriceChange(tx, priceChangeId));
  return json({ priceChange });
});
