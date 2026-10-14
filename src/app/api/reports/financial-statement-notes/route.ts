import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getStatementNotes, saveStatementNotes } from "@/lib/reports/financial-statements";

/** The notes to the financial statements: the organisation's saved notes, or drafts (FS2). */
export const GET = route(async (request) => {
  const notes = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getStatementNotes(tx));
  return json(notes);
});

/** Saves the notes (`notes`: `{ title, body }` in order), replacing any saved before. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const notes = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => saveStatementNotes(tx, { notes: body.notes }));
  return json(notes);
});
