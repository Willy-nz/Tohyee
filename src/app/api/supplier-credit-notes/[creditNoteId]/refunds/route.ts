import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listSupplierCreditNoteRefunds, refundSupplierCreditNote } from "@/lib/supplier-credit-notes/refunds";

type Context = { params: Promise<{ creditNoteId: string }> };

/** GET: the refunds received for the supplier credit note, active and voided, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const params = searchParams(request);
  const refunds = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listSupplierCreditNoteRefunds(tx, creditNoteId),
  );
  return json({ refunds });
});

/**
 * Records the supplier refunding remaining credit: posts Dr the bank account /
 * Cr accounts payable on `refundDate`. It can't be more than the remaining credit.
 */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    refundSupplierCreditNote(tx, creditNoteId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      refundDate: body.refundDate,
      amount: body.amount,
      bankAccountCode: body.bankAccountCode,
      reference: body.reference,
      exchangeRate: body.exchangeRate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
