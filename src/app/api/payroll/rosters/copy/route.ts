import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { copyPreviousWeek } from "@/lib/payroll/rosters";

/** Copies the week before's shifts into an area's week (RS9), leaving out and listing any that can't be rostered. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const roster = await withPayrollAccess(request, body.organisationId, (tx) => copyPreviousWeek(tx, { areaId: body.areaId, weekStart: body.weekStart }));
  return json({ roster });
});
