import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getTag, updateTag } from "@/lib/rd/tags";

type Context = { params: Promise<{ tagId: string }> };

/** GET: a tag with its history and files (viewers and above). */
export const GET = route<Context>(async (request, context) => {
  const { tagId } = await context.params;
  const tag = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getTag(tx, tagId));
  return json({ tag });
});

/** PATCH: changes a tag (bookkeepers and above); the old version stays in its history (RD23). */
export const PATCH = route<Context>(async (request, context) => {
  const { tagId } = await context.params;
  const body = await readJson(request);
  const tag = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateTag(tx, tagId, body));
  return json({ tag });
});
