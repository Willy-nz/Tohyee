import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addNotebookEntry, listNotebook } from "@/lib/ai-workspace/notebook";

/** The farm notebook (AIW1): notes by category, newest first. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const notes = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listNotebook(tx, { category: params.get("category"), search: params.get("search") }));
  return json({ notes });
});

/** Adds a note (`category`, `title`, `body`, optional `happenedOn`). Bookkeepers. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const note = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => addNotebookEntry(tx, { category: body.category, title: body.title, body: body.body, happenedOn: body.happenedOn }));
  return json({ note }, { status: 201 });
});
