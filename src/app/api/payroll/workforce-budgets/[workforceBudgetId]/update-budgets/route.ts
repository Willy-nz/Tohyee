import { json, readJson, route, withPayrollAccess } from "@/lib/api/http";
import { updateFedBudgets } from "@/lib/payroll/workforce-budgets";

type Context = { params: Promise<{ workforceBudgetId: string }> };

/** POST: rewrites the fed budgets from today's figures, e.g. after an allocation changed (WB3). */
export const POST = route<Context>(async (request, context) => {
  const { workforceBudgetId } = await context.params;
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => updateFedBudgets(tx, workforceBudgetId));
  return json(result);
});
