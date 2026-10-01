import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { getWorkforceBudget, updateWorkforceBudget } from "@/lib/payroll/workforce-budgets";

type Context = { params: Promise<{ workforceBudgetId: string }> };

/** GET: a workforce budget with its lines' monthly figures, Department totals and fed budgets (WB1-WB3). */
export const GET = route<Context>(async (request, context) => {
  const { workforceBudgetId } = await context.params;
  const query = searchParams(request);
  const workforceBudget = await withPayrollAccess(request, query.get("organisationId"), (tx) => getWorkforceBudget(tx, workforceBudgetId));
  return json({ workforceBudget });
});

/** PUT: name, firstMonth, months and budgetIds (the budgets it feeds), against `version` (WB2, WB4). */
export const PUT = route<Context>(async (request, context) => {
  const { workforceBudgetId } = await context.params;
  const body = await readJson(request);
  const workforceBudget = await withPayrollAccess(request, body.organisationId, (tx) => updateWorkforceBudget(tx, workforceBudgetId, body));
  return json({ workforceBudget });
});
