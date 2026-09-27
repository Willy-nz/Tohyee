import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { approveCreditNote } from "@/lib/credit-notes/service";

type Context = { params: Promise<{ creditNoteId: string }> };

/** Approves a draft: gives it the next credit note number and posts its journal on the credit note date. */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    approveCreditNote(tx, creditNoteId, { source: body.source, idempotencyKey: body.idempotencyKey }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
