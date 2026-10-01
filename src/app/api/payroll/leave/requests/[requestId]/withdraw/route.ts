import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { withdrawLeaveRequest } from "@/lib/payroll/leave-requests";

type Context = { params: Promise<{ requestId: string }> };

/** Withdraws a request before it's decided: the employee only (HL50). Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "viewer", (tx, { membership }) => withdrawLeaveRequest(tx, membership.role, requestId));
  return json(result);
});
