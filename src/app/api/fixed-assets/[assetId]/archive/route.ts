import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { archiveFixedAsset } from "@/lib/fixed-assets/service";

type Context = { params: Promise<{ assetId: string }> };

/** Archives an asset registered by mistake, while it has no depreciation or disposal (FA14). */
export const POST = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const asset = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => archiveFixedAsset(tx, assetId));
  return json({ asset });
});
