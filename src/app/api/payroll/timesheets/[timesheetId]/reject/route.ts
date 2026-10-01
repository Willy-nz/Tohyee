import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { rejectTimesheet } from "@/lib/payroll/timesheets";

type Context = { params: Promise<{ timesheetId: string }> };

/** Sends a submitted timesheet back to draft with a reason (TS4). Body: { organisationId, reason }. */
export const POST = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) =>
    rejectTimesheet(tx, membership.role, timesheetId, { reason: body.reason }),
  );
  return json(result);
});
