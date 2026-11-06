import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listSuggestions, mobBcs, photosFor } from "@/lib/farming/bcs";

type Context = { params: Promise<{ mobId: string }> };

/** GET: a mob's BCS records, trend (its own and its tagged animals'), targets, photos and AI suggestions. */
export const GET = route<Context>(async (request, context) => {
  const { mobId } = await context.params;
  const result = await withFarmWork(request, searchParams(request).get("organisationId"), "read", async (tx) => ({ ...(await mobBcs(tx, mobId)), photos: await photosFor(tx, { mobId }), suggestions: await listSuggestions(tx, { mobId }) }));
  return json(result);
});
