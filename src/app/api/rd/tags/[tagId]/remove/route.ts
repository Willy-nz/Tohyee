import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { removeTag } from "@/lib/rd/tags";

type Context = { params: Promise<{ tagId: string }> };

/** POST: removes a tag with a reason (bookkeepers and above). It's kept in history and stops counting. */
export const POST = route<Context>(async (request, context) => {
  const { tagId } = await context.params;
  const body = await readJson(request);
  const tag = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => removeTag(tx, tagId, body.reason));
  return json({ tag });
});
