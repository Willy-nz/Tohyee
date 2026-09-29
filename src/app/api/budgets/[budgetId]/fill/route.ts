import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { fillBudget } from "@/lib/budgets/service";

type Context = { params: Promise<{ budgetId: string }> };

/**
 * Quick fill (BU3, BU4): `accountCodes`, `from` (YYYY-MM), `months`, `method`
 * ("same" with `amount`, or "actuals"), optional `percent`; `version` is the one loaded.
 */
export const POST = route<Context>(async (request, context) => {
  const { budgetId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    fillBudget(tx, budgetId, {
      version: body.version,
      accountCodes: body.accountCodes,
      from: body.from,
      months: body.months,
      method: body.method,
      amount: body.amount,
      percent: body.percent,
    }),
  );
  return json(result);
});
