import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { parseIsoDate } from "@/lib/dates";
import { tasksDue } from "@/lib/farming/tasks";

/** GET: open tasks' dates from `from` to `to` (optionally one `farmId`), for the farm calendar (FT6). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const items = await withFarmWork(request, params.get("organisationId"), "read", (tx) => tasksDue(tx, { from: parseIsoDate(params.get("from"), "From"), to: parseIsoDate(params.get("to"), "To"), farmId: params.get("farmId") }));
  return json({ items });
});
