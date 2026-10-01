import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { updatePayRunLeave } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string }> };

/** "Update leave" on a draft (decision 141): works leave out again, for everyone or one employee. Body: { organisationId, employeeId? }. */
export const POST = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => updatePayRunLeave(tx, payRunId, body.employeeId));
  return json(result);
});
