import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { updateProjectExpense } from "@/lib/projects/service";

type Context = { params: Promise<{ expenseId: string }> };

/** Changes whether an unbilled expense is chargeable, and its markup (PJ4, PJ8). */
export const PUT = route<Context>(async (request, context) => {
  const { expenseId } = await context.params;
  const body = await readJson(request);
  const project = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateProjectExpense(tx, expenseId, { chargeable: body.chargeable, markupPercent: body.markupPercent }),
  );
  return json({ project });
});
