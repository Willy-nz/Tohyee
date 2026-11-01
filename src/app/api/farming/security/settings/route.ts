import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { farmSettings, setFarmRetention } from "@/lib/security-cameras/cameras";

/** GET `?farmId=`: how many days the farm's camera media is kept. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const settings = await withFarmWork(request, params.get("organisationId"), "read", (tx) => farmSettings(tx, params.get("farmId")));
  return json({ settings });
});

/** PUT `{ farmId, retentionDays }`: owners and admins. Audited. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withFarmWork(request, body.organisationId, "read", (tx) => setFarmRetention(tx, body.farmId, body.retentionDays));
  return json({ settings });
});
