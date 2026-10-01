import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveLeaveRequest } from "@/lib/payroll/leave-requests";

type Context = { params: Promise<{ requestId: string }> };

/** Approves a request and books the leave (HL49): the employee's approver or payroll access, never the employee. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) => approveLeaveRequest(tx, membership.role, requestId));
  return json(result);
});
