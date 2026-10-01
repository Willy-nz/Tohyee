import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { createWorkforceBudget, listWorkforceBudgets } from "@/lib/payroll/workforce-budgets";

/** GET: workforce budgets (P11). Bookkeeper and payroll access (decision 122). */
export const GET = route(async (request) => {
  const query = searchParams(request);
  const workforceBudgets = await withPayrollAccess(request, query.get("organisationId"), (tx) => listWorkforceBudgets(tx));
  return json({ workforceBudgets });
});

/** POST: starts a workforce budget (WB1). Body: { organisationId, idempotencyKey, name, firstMonth (YYYY-MM), months }. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withPayrollAccess(request, body.organisationId, (tx) => createWorkforceBudget(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
