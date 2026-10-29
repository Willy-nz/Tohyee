import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { effluentCare } from "@/lib/effluent/care";

/** GET: a farm's systems with their checks, faults and servicing, its incidents and their actions, and what's due (`farmId`). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  return json(await withFarmWork(request, params.get("organisationId"), "read", (tx) => effluentCare(tx, params.get("farmId"))));
});
