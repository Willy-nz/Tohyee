import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { effluentSetup } from "@/lib/effluent/setup";

/** GET: a farm's effluent setup (`farmId`): systems (with Safety's in-use state), ponds, blocks, no-apply zones and consent conditions, and what the person may do. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const setup = await withFarmWork(request, params.get("organisationId"), "read", (tx) => effluentSetup(tx, params.get("farmId"), { includeWithdrawn: params.get("includeWithdrawn") === "true" }));
  return json(setup);
});
