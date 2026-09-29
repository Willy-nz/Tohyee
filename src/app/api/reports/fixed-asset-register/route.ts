import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { fixedAssetRegister } from "@/lib/fixed-assets/register";

/** GET: the fixed asset register as at `asOf`, tied to the ledger (FA13). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const register = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => fixedAssetRegister(tx, { asOf: params.get("asOf") }));
  return json({ register });
});
