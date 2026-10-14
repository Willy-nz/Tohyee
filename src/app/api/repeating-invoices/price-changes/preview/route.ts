import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { previewPriceChange, priceChangeInput } from "@/lib/repeating/price-changes";

/** What a price change would do to each template (RP1-RP4). Saves nothing. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => previewPriceChange(tx, priceChangeInput(body)));
  return json({ preview });
});
