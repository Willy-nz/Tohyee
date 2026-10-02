import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteJournalDraft, getJournalDraft, updateJournalDraft } from "@/lib/ledger/journal-drafts";

type Context = { params: Promise<{ draftId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { draftId } = await context.params;
  const draft = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getJournalDraft(tx, draftId));
  return json({ draft });
});

/** PUT: replaces a draft's date, reference, description and lines (MJD3). Refused once posted. */
export const PUT = route<Context>(async (request, context) => {
  const { draftId } = await context.params;
  const body = await readJson(request);
  const draft = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    updateJournalDraft(tx, draftId, {
      postingDate: body.postingDate,
      reference: body.reference,
      description: body.description,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json({ draft });
});

/** DELETE: deletes a draft that hasn't been posted (MJD7). */
export const DELETE = route<Context>(async (request, context) => {
  const { draftId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteJournalDraft(tx, draftId));
  return json({ ok: true });
});
