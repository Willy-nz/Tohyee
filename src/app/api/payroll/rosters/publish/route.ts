import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { publishRoster } from "@/lib/payroll/rosters";

/** Publishes an area's week (RS4): employees with a login see these shifts. `emailStaff: true` emails those whose shifts are new or changed. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const roster = await withPayrollAccess(request, body.organisationId, (tx) => publishRoster(tx, { areaId: body.areaId, weekStart: body.weekStart, emailStaff: body.emailStaff }));
  return json({ roster });
});
