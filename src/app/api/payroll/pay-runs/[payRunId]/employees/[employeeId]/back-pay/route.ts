import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { addBackPay, removeBackPay } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string; employeeId: string }> };

/**
 * Adds back pay from a pay rate in the employee's history to a draft (XP10,
 * decision 133). Body: { organisationId, payItemId, payRateId }.
 */
export const POST = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) =>
    addBackPay(tx, payRunId, employeeId, { payItemId: body.payItemId, payRateId: body.payRateId }),
  );
  return json(result);
});

/** Takes the back pay worked out from pay rate history off the employee on a draft. */
export const DELETE = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const result = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => removeBackPay(tx, payRunId, employeeId));
  return json(result);
});
