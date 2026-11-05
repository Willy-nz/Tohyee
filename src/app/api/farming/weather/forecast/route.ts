import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { getFarmForecast } from "@/lib/weather/service";

/** GET: a farm's MetService forecast, with the attribution (decision 1546). Farm staff and up, on the farms they see. */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const forecast = await withFarmWork(request, query.get("organisationId"), "read", (tx, { membership }) =>
    getFarmForecast(tx, query.get("farmId"), { canRefresh: roleAtLeast(membership.role, "bookkeeper") }),
  );
  return json({ forecast }, { headers: { "cache-control": "private, no-store" } });
});
