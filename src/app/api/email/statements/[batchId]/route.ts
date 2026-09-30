import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getStatementRun } from "@/lib/email/documents";

type Context = { params: Promise<{ batchId: string }> };

/** GET: a statement run's results, customer by customer. */
export const GET = route<Context>(async (request, context) => {
  const { batchId } = await context.params;
  const run = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getStatementRun(tx, batchId));
  return json({ run });
});
