import { json, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { workforceBudgetVsActual } from "@/lib/payroll/workforce-budgets";

type Context = { params: Promise<{ workforceBudgetId: string }> };

/** GET: budget vs actual for wages by month and Department, against P10's labour cost (WB5). Read-only. */
export const GET = route<Context>(async (request, context) => {
  const { workforceBudgetId } = await context.params;
  const query = searchParams(request);
  const result = await withPayrollAccess(request, query.get("organisationId"), (tx) => workforceBudgetVsActual(tx, workforceBudgetId));
  return json(result);
});
