import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSupplierPayments, recordSupplierPayment } from "@/lib/bills/payments";

type Context = { params: Promise<{ billId: string }> };

/** GET: the bill's payments, active and voided, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const params = searchParams(request);
  const payments = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSupplierPayments(tx, billId),
  );
  return json({ payments });
});

/**
 * Records a payment against an approved bill: posts Dr accounts payable /
 * Cr the bank account on `paymentDate`. It can't be more than the amount due.
 */
export const POST = route<Context>(async (request, context) => {
  const { billId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    recordSupplierPayment(tx, billId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      paymentDate: body.paymentDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      reference: body.reference,
      exchangeRate: body.exchangeRate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
