import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { removePayRunEmployee, setPayRunEmployeeLines } from "@/lib/payroll/pay-runs";

type Context = { params: Promise<{ payRunId: string; employeeId: string }> };

/**
 * Replaces an employee's earnings and deductions on a draft (PRUN2). Body:
 * { organisationId, lines: [{ payItemId, quantity?, rate?, amount?, description?, regular? }], keepUsualPay? }.
 * Leave lines stay (Tohyee works them out); with keepUsualPay the usual pay
 * made from the usual week stays Tohyee's too (decision 149).
 */
export const PUT = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => setPayRunEmployeeLines(tx, payRunId, employeeId, { lines: body.lines, keepUsualPay: body.keepUsualPay }));
  return json(result);
});

/** Leaves the employee out of a draft (PRUN11). */
export const DELETE = route<Context>(async (request, context) => {
  const { payRunId, employeeId } = await context.params;
  const result = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => removePayRunEmployee(tx, payRunId, employeeId));
  return json(result);
});
