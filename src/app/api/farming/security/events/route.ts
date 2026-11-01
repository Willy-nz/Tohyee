import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { businessTimeZone } from "@/lib/dates";
import { listEvents } from "@/lib/security-cameras/events";

/**
 * GET: camera events, newest first, 60 at a time. Filters: `farmId` (none
 * for every farm the person sees), `cameraId`, `kind` (snapshot or clip),
 * `from` and `to` (dates), `kept=1`, and `before` (an event id) for the
 * next page. For people with camera access (decision 1220).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withFarmWork(request, params.get("organisationId"), "read", (tx) =>
    listEvents(tx, { farmId: params.get("farmId"), cameraId: params.get("cameraId"), kind: params.get("kind"), from: params.get("from"), to: params.get("to"), kept: params.get("kept"), before: params.get("before") }, businessTimeZone()),
  );
  return json(result);
});
