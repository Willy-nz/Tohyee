import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { headCount } from "@/lib/livestock/movements";

/** GET: the head count reconciliation for the year ending `yearEnd` (LV1-LV3). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => headCount(tx, { yearEnd: params.get("yearEnd") }));
  return json({ headCount: result });
});
