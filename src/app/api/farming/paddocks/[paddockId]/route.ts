import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getPaddock, updatePaddock } from "@/lib/farming/paddocks";

type Context = { params: Promise<{ paddockId: string }> };

/** GET: a paddock with every version of its boundary and where it came from. */
export const GET = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const paddock = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getPaddock(tx, paddockId));
  return json({ paddock });
});

/** Renames a paddock or changes its effective area. */
export const PATCH = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const body = await readJson(request);
  const paddock = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updatePaddock(tx, paddockId, { name: body.name, effectiveHa: body.effectiveHa }));
  return json({ paddock });
});
