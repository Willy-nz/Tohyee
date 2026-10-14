import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { farmBenchmarks } from "@/lib/farming/benchmarks";

/** The year's farm working expenses by group and gross farm revenue, in total and per kgMS, ha, cow and su (FK1-FK4). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => farmBenchmarks(tx, { yearEnd: params.get("yearEnd") }));
  return json(report);
});
