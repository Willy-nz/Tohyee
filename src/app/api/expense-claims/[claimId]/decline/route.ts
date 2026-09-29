import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { declineExpenseClaim } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** Returns a submitted claim to its claimant as a draft, with a `reason` (EC6). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const claim = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    declineExpenseClaim(tx, membership.role, claimId, { reason: body.reason }),
  );
  return json({ claim });
});
