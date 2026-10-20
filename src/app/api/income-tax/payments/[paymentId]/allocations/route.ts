import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { addAllocation } from "@/lib/tax/income/allocations";

type Context = { params: Promise<{ paymentId: string }> };

/**
 * POST: allocates a payment, or part of it, to an instalment or the end-of-year tax (owners and admins; ITX6A-ITX6H).
 * Body: `idempotencyKey`, `appliesTo` (instalment_1, instalment_2, instalment_3 or end_of_year), `amount`, `status`
 * (confirmed, which needs `irdDocumentId`; evidenced; or forecast) and `basis` (the evidence or assumption).
 */
export const POST = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    addAllocation(tx, { idempotencyKey: body.idempotencyKey, paymentId, appliesTo: body.appliesTo, amount: body.amount, status: body.status, basis: body.basis, irdDocumentId: body.irdDocumentId }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
