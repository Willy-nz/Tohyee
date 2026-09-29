import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { recordExpenseClaimPayment } from "@/lib/expense-claims/service";

type Context = { params: Promise<{ claimId: string }> };

/** Pays an approved claim from a bank account: Dr expense claims payable / Cr bank (EC4, EC5). */
export const POST = route<Context>(async (request, context) => {
  const { claimId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx, { membership }) =>
    recordExpenseClaimPayment(tx, membership.role, claimId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      paymentDate: body.paymentDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      reference: body.reference,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
