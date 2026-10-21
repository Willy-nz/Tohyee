import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { farmComparison } from "@/lib/farming/comparison";

/** GET: every active farm's area, pasture freshness and latest fertiliser plan side by side, with all farms together (PF9). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const comparison = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => farmComparison(tx, { onDate: params.get("onDate") }));
  return json({ comparison });
});
