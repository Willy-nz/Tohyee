import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { removePayRunEmployee, setPayRunEmployeeLines } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string; employeeId: string }> };

/**
 * Replaces an employee's earnings and deductions on a draft (PRUN2). Body:
 * { organisationId, lines: [{ payItemId, quantity?, rate?, amount?, description? }] }.
 */
export const PUT = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => setPayRunEmployeeLines(tx, payRunId, employeeId, { lines: body.lines }));
  return json(result);
});

/** Leaves the employee out of a draft (PRUN11). */
export const DELETE = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const result = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => removePayRunEmployee(tx, payRunId, employeeId));
  return json(result);
});
