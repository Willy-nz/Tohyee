import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { safetyToday } from "@/lib/safety/today";

/** GET: what Today shows from Safety for a farm (the person's actions, important hazards, machines, training, inductions). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const today = await withFarmWork(request, params.get("organisationId"), "read", (tx) => safetyToday(tx, params.get("farmId")));
  return json(today);
});
