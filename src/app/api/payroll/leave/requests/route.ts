import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createLeaveRequest, listLeaveRequests } from "@/lib/payroll/leave-requests";

/**
 * Leave requests (decision 169; HL49-HL51). Viewers and above: each person
 * sees their own requests, the ones they approve, or everyone's with
 * payroll access (the service decides, as for timesheets, decision 95).
 * Days and hours only, never pay. Query: organisationId, status?, asAt? (for the employee's own balances).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { membership }) =>
    listLeaveRequests(tx, membership.role, { status: params.get("status"), asAt: params.get("asAt") }),
  );
  return json(result);
});

/** Asks for leave: the employee themselves. Body: { organisationId, idempotencyKey, employeeId, leaveType, startDate, endDate?, dayHours?, bereavementKind?, note? }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const { organisationId, ...input } = body;
  const result = await withOrganisation(request, organisationId, "viewer", (tx, { membership }) => createLeaveRequest(tx, membership.role, input));
  return json(result, { status: result.created ? 201 : 200 });
});
