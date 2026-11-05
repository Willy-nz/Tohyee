import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { forecastVsGauge } from "@/lib/weather/service";

/**
 * GET: forecast vs your rain gauge, by rain day (decision 1549). Only when
 * an admin has turned on both permission switches. Farm staff and up.
 */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const comparison = await withFarmWork(request, query.get("organisationId"), "read", (tx) => forecastVsGauge(tx, { farmId: query.get("farmId"), gaugeId: query.get("gaugeId") || undefined, days: query.get("days") ?? undefined }));
  return json({ comparison });
});
