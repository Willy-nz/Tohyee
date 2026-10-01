import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { timesheetTargets } from "@/lib/payroll/timesheets";

/** What timesheet rows can name (TS2): active Departments, open projects, active R&D activities. Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const targets = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => timesheetTargets(tx));
  return json({ targets });
});
