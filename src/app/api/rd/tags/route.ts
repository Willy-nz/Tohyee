import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { createTag } from "@/lib/rd/tags";

/** POST: tags a line to an R&D activity (bookkeepers and above; RD8, RD9, RD12, RD13). */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const result = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createTag(tx, body));
  return json(result, { status: result.created ? 201 : 200 });
});
