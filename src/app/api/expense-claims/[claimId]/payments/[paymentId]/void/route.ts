import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidExpenseClaimPayment } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string; paymentId: string }> };

/** Voids a payment: the exact reversal on `voidDate`, so the amount is due again (EC5). */
export const POST = route<Context>(async (request, context) => {
  const { claimId, paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    voidExpenseClaimPayment(tx, membership.role, claimId, paymentId, { source: body.source, idempotencyKey: body.idempotencyKey, voidDate: body.voidDate }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
