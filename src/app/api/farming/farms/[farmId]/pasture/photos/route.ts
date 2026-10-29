import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listPasturePhotos } from "@/lib/farming/pasture-photos";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's photos, newest first (`paddockId`, `limit`). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const photos = await withFarmWork(request, params.get("organisationId"), "read", (tx) => listPasturePhotos(tx, { farmId, paddockId: params.get("paddockId"), limit: params.get("limit") }));
  return json({ photos });
});
