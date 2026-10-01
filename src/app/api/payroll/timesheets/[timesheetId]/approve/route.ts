import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveTimesheet } from "@/lib/payroll/timesheets";

type Context = { params: Promise<{ timesheetId: string }> };

/** Approves a submitted timesheet (TS4): its approver or someone with payroll access, never the employee. Posts nothing. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) => approveTimesheet(tx, membership.role, timesheetId));
  return json(result);
});
