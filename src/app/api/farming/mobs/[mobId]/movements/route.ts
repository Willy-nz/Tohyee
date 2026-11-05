import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { linkableMovements } from "@/lib/farming/mobs";

type Context = { params: Promise<{ mobId: string }> };

/** GET: livestock movements (`type`: sale or purchase) this mob's sale or purchase can link to (MOB7). Bookkeepers and above. */
export const GET = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const params = searchParams(request);
  const movements = await withOrganisation(request, params.get("organisationId"), "bookkeeper", (tx) => linkableMovements(tx, mobId, { type: params.get("type") }));
  return json({ movements });
});
