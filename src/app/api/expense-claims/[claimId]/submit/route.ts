import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { submitExpenseClaim } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** Sends the signed-in person's draft for approval (EC2). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const claim = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => submitExpenseClaim(tx, claimId));
  return json({ claim });
});
