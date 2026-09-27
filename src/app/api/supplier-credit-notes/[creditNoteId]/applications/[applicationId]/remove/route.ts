import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeSupplierCreditNoteApplication } from "@/lib/supplier-credit-notes/applications";

type Context = { params: Promise<{ creditNoteId: string; applicationId: string }> };

/** Removes an application on `removalDate`: the credit is available again and the bill is due again. */
export const POST = route<Context>(async (request, context) => {
  const { creditNoteId, applicationId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    removeSupplierCreditNoteApplication(tx, creditNoteId, applicationId, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      removalDate: body.removalDate,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
