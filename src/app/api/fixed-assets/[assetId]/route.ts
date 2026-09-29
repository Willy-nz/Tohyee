import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getFixedAsset, updateFixedAsset } from "@/lib/fixed-assets/service";

type Context = { params: Promise<{ assetId: string }> };

/** GET: the asset with its depreciation history and disposals. */
export const GET = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const asset = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getFixedAsset(tx, assetId));
  return json({ asset });
});

/** Changes an asset: name, description and tracking always; the rest only before it's depreciated (FA14). */
export const PUT = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const asset = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateFixedAsset(tx, assetId, body));
  return json({ asset });
});
