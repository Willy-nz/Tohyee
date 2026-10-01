import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { deletePayRun, getPayRun } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string }> };

/** The pay run with each employee's pay; a draft is calculated from their current details (PRUN11). */
export const GET = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const payRun = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => getPayRun(tx, payRunId));
  return json({ payRun });
});

/** Deletes a draft. */
export const DELETE = route<Context>(async (request, context) => {
  const { payRunId } = await context.params;
  const result = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => deletePayRun(tx, payRunId));
  return json(result);
});
