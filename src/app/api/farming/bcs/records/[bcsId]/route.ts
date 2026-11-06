import { json, readJson, route, withFarmWork } from "@/lib/api/http";
import { removeBcs } from "@/lib/farming/bcs";

type Context = { params: Promise<{ bcsId: string }> };

/** PATCH `{ removed: true, reason }`: removes a score entered by mistake (kept). Bookkeepers and up. */
export const PATCH = route<Context>(async (request, context) => {
  const { bcsId } = await context.params;
  const body = await readJson(request);
  await withFarmWork(request, body.organisationId, "record", (tx) => removeBcs(tx, bcsId, { reason: body.reason }));
  return json({ removed: true });
});
