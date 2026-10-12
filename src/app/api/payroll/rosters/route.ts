import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getRosterWeek } from "@/lib/payroll/rosters";

/** GET: an area's roster for the week a date is in (`areaId`, `weekStart`), with costs, warnings and changes since published (RS1-RS4). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const roster = await withPayrollAccess(request, params.get("organisationId"), (tx) => getRosterWeek(tx, { areaId: params.get("areaId"), weekStart: params.get("weekStart") }));
  return json({ roster });
});
