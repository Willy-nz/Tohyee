import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { enterTaxDepreciation } from "@/lib/rd/assets";

type Context = { params: Promise<{ assetId: string }> };

/** POST: enters the asset's tax depreciation and Investment Boost for an income year (bookkeepers and above; decision 33). */
export const POST = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => enterTaxDepreciation(tx, assetId, body));
  return json(result, { status: result.created ? 201 : 200 });
});
