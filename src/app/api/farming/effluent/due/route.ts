import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { effluentDue } from "@/lib/effluent/care";

/** GET: Effluent's dates for the farm calendar (`from`, `to`, optional `farmId`): servicing, Effluent WoF and consent expiry. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const items = await withFarmWork(request, params.get("organisationId"), "read", (tx) => effluentDue(tx, { from: parseIsoDate(params.get("from"), "From"), to: parseIsoDate(params.get("to"), "To"), farmId: params.get("farmId") }));
  return json({ items });
});
