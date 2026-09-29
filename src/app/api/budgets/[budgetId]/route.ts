import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getBudget, renameBudget } from "@/lib/budgets/service";

type Context = { params: Promise<{ budgetId: string }> };

/** GET: the budget's amounts per account and month, `months` (default 12) months from `from` (YYYY-MM). */
export const GET = route<Context>(async (request, context) => {
  const { budgetId } = await context.params;
  const params = searchParams(request);
  const grid = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    getBudget(tx, budgetId, { from: params.get("from"), months: params.get("months") }),
  );
  return json(grid);
});

/** Renames a budget. `version` is the one that was loaded. */
export const PUT = route<Context>(async (request, context) => {
  const { budgetId } = await context.params;
  const body = await readJson(request);
  const budget = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => renameBudget(tx, budgetId, { name: body.name, version: body.version }));
  return json({ budget });
});
