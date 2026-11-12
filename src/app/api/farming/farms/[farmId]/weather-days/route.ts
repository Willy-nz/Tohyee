import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { recentFarmWeather } from "@/lib/farming/weather-history";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's last 30 days of rain and temperature (its gauges first, else MetService), or why there are none (FW4). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const weather = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => recentFarmWeather(tx, farmId));
  return json({ weather });
});
