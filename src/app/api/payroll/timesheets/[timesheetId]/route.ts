import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getTimesheet, saveTimesheetEntries } from "@/lib/payroll/timesheets";

type Context = { params: Promise<{ timesheetId: string }> };

/** One timesheet with its rows, changes and history (TS2-TS4, TS10). */
export const GET = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const params = searchParams(request);
  const timesheet = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { membership }) =>
    getTimesheet(tx, membership.role, timesheetId),
  );
  return json({ timesheet });
});

/** Saves the week's hours (TS2, TS3). Body: { organisationId, version, rows: [{ rdActivityId?, departmentId?, projectId?, description?, hours: { "YYYY-MM-DD": "7.50" } }] }. */
export const PUT = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) =>
    saveTimesheetEntries(tx, membership.role, timesheetId, { version: body.version, rows: body.rows }),
  );
  return json(result);
});
