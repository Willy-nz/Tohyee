import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listPriceChanges, priceChangeInput, savePriceChange } from "@/lib/repeating/price-changes";

/** GET: the latest 100 price changes on repeating invoices, with their lines (RP1-RP8). */
export const GET = route(async (request) => {
  const priceChanges = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listPriceChanges(tx));
  return json({ priceChanges });
});

/** Saves a price change: templates change from its date. Nothing posts. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const priceChange = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => savePriceChange(tx, priceChangeInput(body)));
  return json({ priceChange }, { status: 201 });
});
