import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteMeasure } from "@/lib/analytics/saved-measures";

type Context = { params: Promise<{ measureId: string }> };

/** Removes a saved value. Charts that use it keep their own copy of how it's worked out. */
export const DELETE = route<Context>(async (request, context) => {
  const { measureId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteMeasure(tx, measureId));
  return json({ ok: true });
});
