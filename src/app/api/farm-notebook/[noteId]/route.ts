import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { archiveNotebookEntry, updateNotebookEntry } from "@/lib/ai-workspace/notebook";

type Context = { params: Promise<{ noteId: string }> };

/** Replaces a note's category, title, text and date (AIW2). Bookkeepers. */
export const PUT = route<Context>(async (request, context) => {
  const { noteId } = await context.params;
  const body = await readJson(request);
  const note = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateNotebookEntry(tx, noteId, { category: body.category, title: body.title, body: body.body, happenedOn: body.happenedOn }));
  return json({ note });
});

/** Archives a note. Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { noteId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => archiveNotebookEntry(tx, noteId));
  return json({ archived: true });
});
