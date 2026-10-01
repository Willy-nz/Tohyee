import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listTaggedCosts } from "@/lib/rd/costs";

/** GET: tagged costs for an income year by activity and category (viewers and above). Not the claim: that's stage R3. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const costs = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listTaggedCosts(tx, params.get("incomeYear")));
  return json({ costs });
});
