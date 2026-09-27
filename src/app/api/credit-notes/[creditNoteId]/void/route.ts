import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { voidCreditNote } from "@/lib/credit-notes/service";

type Context = { params: Promise<{ creditNoteId: string }> };

/**
 * Voids an approved credit note: posts the exact reversal of its journal on
 * `voidDate`. Refused while it has active applications or refunds.
 */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    voidCreditNote(tx, creditNoteId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      voidDate: body.voidDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
