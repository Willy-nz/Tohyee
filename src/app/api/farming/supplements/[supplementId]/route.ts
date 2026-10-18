import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeSupplement } from "@/lib/farming/pasture";

type Context = { params: Promise<{ supplementId: string }> };

/** Removes a supplement recorded by mistake; it's kept for the history. */
export const DELETE = route<Context>(async (request, context) => {
  const { supplementId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeSupplement(tx, supplementId));
  return json({ ok: true });
});
