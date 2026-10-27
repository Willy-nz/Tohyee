import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { paddockPasture } from "@/lib/farming/pasture";

type Context = { params: Promise<{ paddockId: string }> };

/** GET: the paddock's cover readings (with growth) and grazings, newest first. */
export const GET = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const pasture = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => paddockPasture(tx, paddockId));
  return json({ pasture });
});
