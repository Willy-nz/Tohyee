import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getAssetRd } from "@/lib/rd/assets";

type Context = { params: Promise<{ assetId: string }> };

/** GET: a fixed asset's R&D tax depreciation, usage log and split (viewers and above; RD11). */
export const GET = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const asset = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getAssetRd(tx, assetId));
  return json({ asset });
});
