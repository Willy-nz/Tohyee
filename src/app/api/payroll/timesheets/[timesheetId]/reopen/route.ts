import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { reopenTimesheet } from "@/lib/payroll/timesheets";

type Context = { params: Promise<{ timesheetId: string }> };

/** Reopens an approved timesheet with a reason (TS4, TS9): payroll access only, never once an approved pay run used it. Body: { organisationId, reason }. */
export const POST = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) =>
    reopenTimesheet(tx, membership.role, timesheetId, { reason: body.reason }),
  );
  return json(result);
});
