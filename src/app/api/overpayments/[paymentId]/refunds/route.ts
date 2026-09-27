import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listOverpaymentRefunds, refundOverpayment } from "@/lib/invoices/overpayments";

type Context = { params: Promise<{ paymentId: string }> };

/** GET: the overpayment's refunds, active and voided, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  const params = searchParams(request);
  const refunds = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listOverpaymentRefunds(tx, paymentId),
  );
  return json({ refunds });
});

/**
 * Refunds what's left of the overpayment to the customer: posts Dr accounts
 * receivable / Cr the bank account on `refundDate`.
 */
export const POST = route<Context>(async (request, context) => {
  const { paymentId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    refundOverpayment(tx, paymentId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      refundDate: body.refundDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      reference: body.reference,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
