import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { lastFarm, rememberFarm } from "@/lib/farming/last-farm";

/** GET: the farm you last worked on, if it's still active and yours to see (decision 900); `farmId` is null otherwise. */
export const GET = route(async (request) => {
  const farmId = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => lastFarm(tx));
  return json({ farmId });
});

/** PUT `{ farmId }`: remembers the farm you chose, for the next farm page you open on any device. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const farmId = await withFarmWork(request, body.organisationId, "read", (tx) => rememberFarm(tx, body.farmId));
  return json({ farmId });
});
