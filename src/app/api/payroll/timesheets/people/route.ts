import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listMembers } from "@/lib/organisations/members";
import { listTimesheetPeople, setTimesheetPeople } from "@/lib/payroll/timesheets";

async function members(organisationId: string) {
  return (await listMembers(organisationId))
    .filter((member) => member.isActive)
    .map((member) => ({ userId: member.userId, email: member.email, displayName: member.displayName, role: member.role }));
}

/** Each employee's login and timesheet approver (TS1). Payroll access and the bookkeeper role. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withPayrollAccess(request, params.get("organisationId"), async (tx) => ({
    people: await listTimesheetPeople(tx),
    members: await members(tx.organisationId),
  }));
  return json(result);
});

/** Links an employee to a login and sets their approver. Body: { organisationId, employeeId, userId, approverUserId } (null clears). */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const people = await withPayrollAccess(request, body.organisationId, (tx) =>
    setTimesheetPeople(tx, body.employeeId, { userId: body.userId, approverUserId: body.approverUserId }),
  );
  return json({ people });
});
