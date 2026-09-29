import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { setBudgetArchived } from "@/lib/budgets/service";
import { ValidationError } from "@/lib/errors";

type Context = { params: Promise<{ budgetId: string }> };

/** Archives a named budget (`archived: true`) or brings it back (`archived: false`). The overall budget stays (BU1). */
export const POST = route<Context>(async (request, context) => {
  const { budgetId } = await context.params;
  const body = await readJson(request);
  if (typeof body.archived !== "boolean") throw new ValidationError("archived must be true or false.");
  const archived = body.archived;
  const budget = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setBudgetArchived(tx, budgetId, archived));
  return json({ budget });
});
