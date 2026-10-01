import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { cancelUnpaidLeave } from "@/lib/payroll/leave-records";

type Context = { params: Promise<{ unpaidLeaveId: string }> };

/** Cancels unpaid leave recorded by mistake. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { unpaidLeaveId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => cancelUnpaidLeave(tx, unpaidLeaveId));
  return json(result);
});
