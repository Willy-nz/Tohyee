import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeProjectExpense } from "@/lib/projects/service";

type Context = { params: Promise<{ expenseId: string }> };

/** Takes an unbilled expense off its project. */
export const POST = route<Context>(async (request, context) => {
  const { expenseId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => removeProjectExpense(tx, expenseId));
  return json({ project });
});
