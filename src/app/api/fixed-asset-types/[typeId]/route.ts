import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateFixedAssetType } from "@/lib/fixed-assets/service";

type Context = { params: Promise<{ typeId: string }> };

/** Changes an asset type's name, default method and rate, or (before it has assets) its accounts. Admins. */
export const PUT = route<Context>(async (request, context) => {
  const { typeId } = await context.params;
  const body = await readJson(request);
  const type = await withOrganisation(request, body.organisationId, "admin", (tx) => updateFixedAssetType(tx, typeId, body));
  return json({ type });
});
