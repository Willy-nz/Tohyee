import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { reallocate } from "@/lib/tax/income/allocations";

type Context = { params: Promise<{ allocationId: string }> };

/** POST: reallocates; the old allocation is kept with the `reason` (owners and admins; ITX6G). Same body as allocating, plus `reason`. */
export const POST = route<Context>(async (request, context) => {
  const { allocationId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    reallocate(tx, { idempotencyKey: body.idempotencyKey, allocationId, appliesTo: body.appliesTo, amount: body.amount, status: body.status, basis: body.basis, irdDocumentId: body.irdDocumentId, reason: body.reason }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
