import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { effluentToday } from "@/lib/effluent/care";

/** GET: what Today shows from Effluent for a farm (`farmId`): reminders, systems out of use, open incidents. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  return json(await withFarmWork(request, params.get("organisationId"), "read", (tx) => effluentToday(tx, params.get("farmId"))));
});
