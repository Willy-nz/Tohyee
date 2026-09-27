import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidSupplierCreditNoteRefund } from "@/lib/supplier-credit-notes/refunds";

type Context = { params: Promise<{ creditNoteId: string; refundId: string }> };

/** Voids a refund: posts the exact reversal of its journal on `voidDate`, so the credit is available again. */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId, refundId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidSupplierCreditNoteRefund(tx, creditNoteId, refundId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      voidDate: body.voidDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
