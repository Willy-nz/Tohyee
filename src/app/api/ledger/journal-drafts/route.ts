import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createJournalDraft, listJournalDrafts } from "@/lib/ledger/journal-drafts";

/** GET: draft journals, newest first (`status` draft or posted, `limit` up to 200). Viewers and up. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const drafts = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) =>
    listJournalDrafts(tx, { status: params.get("status"), limit: params.get("limit") ?? undefined }),
  );
  return json({ drafts });
});

/** POST: saves a draft journal (example MJD1). It posts nothing. Retrying with the same idempotencyKey is safe. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    createJournalDraft(tx, {
      source: body.source,
      idempotencyKey: body.idempotencyKey,
      postingDate: body.postingDate,
      reference: body.reference,
      description: body.description,
      lines: body.lines,
      customFields: body.customFields,
    }),
  );
  return json(result, { status: result.created ? 201 : 200 });
});
