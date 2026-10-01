import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listTimesheetWeek, openTimesheet } from "@/lib/payroll/timesheets";

/**
 * Timesheets (examples TS1-TS11). Viewers and above: what each person can
 * see is decided by the service (their own, the ones they approve, or
 * everyone's with payroll access; decision 95). Hours only, never pay.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const week = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { membership }) =>
    listTimesheetWeek(tx, membership.role, params.get("weekStart")),
  );
  return json({ week });
});

/** Opens (or makes) an employee's timesheet for a week. Body: { organisationId, idempotencyKey, employeeId, weekStart }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) =>
    openTimesheet(tx, membership.role, { idempotencyKey: body.idempotencyKey, employeeId: body.employeeId, weekStart: body.weekStart }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
