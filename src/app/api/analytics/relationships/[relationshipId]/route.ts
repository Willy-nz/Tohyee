import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteRelationship } from "@/lib/analytics/relationships";

type Context = { params: Promise<{ relationshipId: string }> };

/** Removes a relationship no report uses (one in use is refused, naming the reports). Bookkeepers and up. */
export const DELETE = route<Context>(async (request, context) => {
  const { relationshipId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteRelationship(tx, relationshipId));
  return json({ ok: true });
});
