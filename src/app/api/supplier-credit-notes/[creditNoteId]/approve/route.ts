import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveSupplierCreditNote } from "@/lib/supplier-credit-notes/service";

type Context = { params: Promise<{ creditNoteId: string }> };

/** Approves a draft: posts its journal (Dr accounts payable / Cr each line's account and GST) on the credit note date. */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    approveSupplierCreditNote(tx, creditNoteId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
