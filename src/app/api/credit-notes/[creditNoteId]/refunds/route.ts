import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listRefunds, refundCreditNote } from "@/lib/credit-notes/refunds";

type Context = { params: Promise<{ creditNoteId: string }> };

/** GET: the credit note's refunds, active and voided, oldest first. */
export const GET = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const params = searchParams(request);
  const refunds = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listRefunds(tx, creditNoteId),
  );
  return json({ refunds });
});

/**
 * Refunds remaining credit to the customer: posts Dr accounts receivable /
 * Cr the bank account on `refundDate`. It can't be more than the remaining credit.
 */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    refundCreditNote(tx, creditNoteId, {
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
