import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { saveWorkforceLines } from "@/lib/payroll/workforce-budgets";

type Context = { params: Promise<{ workforceBudgetId: string }> };

/**
 * PUT: replaces the lines and rewrites the fed budgets (WB1, WB3, WB7).
 * Body: { organisationId, version, lines: [{ employeeId | positionName, payBasis, fte, hoursPerWeek,
 * kiwiSaverRate, startMonth, endMonth, rates: [{ fromMonth, rate }], splits: [{ percentage, departmentId, projectId }] }] }.
 */
export const PUT = route<Context>(async (request, context) => {
  const { workforceBudgetId } = await context.params;
  const body = await readJson(request);
  const workforceBudget = await withPayrollAccess(request, body.organisationId, (tx) =>
    saveWorkforceLines(tx, workforceBudgetId, { version: body.version, lines: body.lines }),
  );
  return json({ workforceBudget });
});
