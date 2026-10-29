import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { paddockPhotos } from "@/lib/farming/pasture-photos";

type Context = { params: Promise<{ paddockId: string }> };

/** GET: the paddock's photo diary, newest first, each with its reading and estimate (`limit`). */
export const GET = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const params = searchParams(request);
  const photos = await withFarmWork(request, params.get("organisationId"), "read", (tx) => paddockPhotos(tx, paddockId, params.get("limit")));
  return json({ photos });
});
