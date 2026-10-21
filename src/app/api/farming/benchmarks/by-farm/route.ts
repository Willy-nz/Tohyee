import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { farmBenchmarksByFarm } from "@/lib/farming/farm-reporting";

/** GET: the year's benchmarks split by farm, with Not allocated and the total (FR2-FR7). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => farmBenchmarksByFarm(tx, { yearEnd: params.get("yearEnd") }));
  return json({ report });
});
