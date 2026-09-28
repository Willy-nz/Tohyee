import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { correctJournal } from "@/lib/ledger/journals";

/** Reverses a posted journal and posts its replacement, both on postingDate. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    correctJournal(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      originalJournalId: body.originalJournalId,
      postingDate: body.postingDate,
      reference: body.reference,
      description: body.description,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
