import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { safetyDue } from "@/lib/safety/today";

/** GET: safety dates from `from` to `to` (optional `farmId`) for the farm calendar: actions due, training expiring, hazard reviews. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const items = await withFarmWork(request, params.get("organisationId"), "read", (tx) =>
    safetyDue(tx, { from: parseIsoDate(params.get("from"), "From"), to: parseIsoDate(params.get("to"), "To"), farmId: params.get("farmId") }),
  );
  return json({ items });
});
