import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { effluentLog } from "@/lib/effluent/log";

/** GET: a farm's effluent log (`farmId`, optional `from`, `to`): runs with their comparison with the consent, pond readings and states, days not applied, and where each system was last moved. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const log = await withFarmWork(request, params.get("organisationId"), "read", (tx) => effluentLog(tx, params.get("farmId"), { from: params.get("from"), to: params.get("to"), includeWithdrawn: params.get("includeWithdrawn") === "true" }));
  return json(log);
});
