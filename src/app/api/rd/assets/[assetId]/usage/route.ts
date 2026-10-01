import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addUsage } from "@/lib/rd/assets";

type Context = { params: Promise<{ assetId: string }> };

/** POST: logs hours the asset was used, on an activity or other work (bookkeepers and above; RD11). */
export const POST = route<Context>(async (request, context) => {
  const { assetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addUsage(tx, assetId, body));
  return json(result, { status: result.created ? 201 : 200 });
});
