import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { postJournalDraft } from "@/lib/ledger/journal-drafts";

type Context = { params: Promise<{ draftId: string }> };

/** POST: posts the draft as a manual journal, once (MJD4, MJD5). Needs the same role as posting a journal. */
export const POST = route<Context>(async (request, context) => {
  const { draftId } = await context.params;
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => postJournalDraft(tx, draftId));
  return json(result, { status: result.created ? 201 : 200 });
});
