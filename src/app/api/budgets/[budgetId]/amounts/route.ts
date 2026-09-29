import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setBudgetAmounts } from "@/lib/budgets/service";

type Context = { params: Promise<{ budgetId: string }> };

/** Sets amounts: `amounts` = [{ accountCode, month (YYYY-MM), amount }]; `version` is the one loaded (BU2). */
export const PUT = route<Context>(async (request, context) => {
  const { budgetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setBudgetAmounts(tx, budgetId, { version: body.version, amounts: body.amounts }),
  );
  return json(result);
});
