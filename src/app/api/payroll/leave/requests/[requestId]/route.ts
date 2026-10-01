import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getLeaveRequest, updateLeaveRequest } from "@/lib/payroll/leave-requests";

type Context = { params: Promise<{ requestId: string }> };

/** A leave request (decision 169): the employee, their approver, or payroll access. Query: organisationId. */
export const GET = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { membership }) => getLeaveRequest(tx, membership.role, requestId));
  return json({ request: result });
});

/** Changes a request before it's decided: the employee only (HL50). Body: { organisationId, leaveType, startDate, endDate?, dayHours?, bereavementKind?, note? }. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const { organisationId, ...input } = await readJson(request);
  const result = await withOrganisation(request, organisationId, "viewer", (tx, { membership }) => updateLeaveRequest(tx, membership.role, requestId, input));
  return json(result);
});
