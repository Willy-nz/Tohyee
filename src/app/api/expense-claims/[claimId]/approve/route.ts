import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveExpenseClaim } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** Approves a submitted claim, posting its journal on `claimDate` (EC3). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    approveExpenseClaim(tx, membership.role, claimId, { source: body.source, idempotencyKey: body.idempotencyKey, claimDate: body.claimDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
