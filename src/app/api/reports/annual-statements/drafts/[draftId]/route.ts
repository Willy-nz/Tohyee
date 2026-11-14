import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteAnnualDraft, saveAnnualDraftNotes } from "@/lib/reports/annual-document";

type Context = { params: Promise<{ draftId: string }> };

/** PUT: saves the set's own notes (`notes`); an empty list goes back to the organisation's notes (FS18). Bookkeepers. */
export const PUT = route<Context>(async (request, context) => {
  const { draftId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => saveAnnualDraftNotes(tx, { draftId, notes: body.notes }));
  return json(result);
});

/** DELETE: deletes a draft set; a final set is saved as a draft first (FS17). Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { draftId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteAnnualDraft(tx, draftId));
  return json({ ok: true });
});
