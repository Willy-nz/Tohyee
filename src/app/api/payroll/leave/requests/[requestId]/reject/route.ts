import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { rejectLeaveRequest } from "@/lib/payroll/leave-requests";

type Context = { params: Promise<{ requestId: string }> };

/** Rejects a request with a reason the employee sees (HL50). Body: { organisationId, reason }. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) => rejectLeaveRequest(tx, membership.role, requestId, { reason: body.reason }));
  return json(result);
});
