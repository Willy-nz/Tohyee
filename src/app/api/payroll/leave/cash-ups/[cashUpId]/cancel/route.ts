import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { cancelCashUp } from "@/lib/payroll/leave-records";

type Context = { params: Promise<{ cashUpId: string }> };

/** Cancels a cash-up no approved pay run has paid. Body: { organisationId }. */
export const POST = route<Context>(async (request, context) => {
  const { cashUpId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => cancelCashUp(tx, cashUpId));
  return json(result);
});
