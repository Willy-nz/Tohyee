import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidExpenseClaim } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** Voids an approved claim with no active payments: the exact reversal on `voidDate` (EC7). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    voidExpenseClaim(tx, membership.role, claimId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
