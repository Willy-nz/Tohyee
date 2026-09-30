import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listPaymentBatches, recordPaymentBatch } from "@/lib/payments/batches";

/** GET: payments for several bills, newest first. Optional `contactId`. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const batches = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listPaymentBatches(tx, "supplier", { contactId: params.get("contactId") }),
  );
  return json({ batches });
});

/**
 * Records one payment for several of a supplier's bills (examples SMP1-SMP3):
 * `documents` lists { id, amount } for each. Posts one journal with one bank
 * line for `amount`.
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    recordPaymentBatch(tx, "supplier", {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      paymentDate: body.paymentDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      reference: body.reference,
      exchangeRate: body.exchangeRate,
      documents: body.documents,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
