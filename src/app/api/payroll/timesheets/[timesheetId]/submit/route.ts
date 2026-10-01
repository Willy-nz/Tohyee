import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { submitTimesheet } from "@/lib/payroll/timesheets";

type Context = { params: Promise<{ timesheetId: string }> };

/** Submits a draft for approval (TS4): the employee or someone with payroll access. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) => submitTimesheet(tx, membership.role, timesheetId));
  return json(result);
});
