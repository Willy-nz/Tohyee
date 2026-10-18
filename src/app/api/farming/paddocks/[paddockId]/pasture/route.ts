import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { paddockPasture } from "@/lib/farming/pasture";

type Context = { params: Promise<{ paddockId: string }> };

/** GET: the paddock's cover readings (with growth) and grazings, newest first. */
export const GET = route<Context>(async (request, context) => {
  const { paddockId } = await context.params;
  const pasture = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => paddockPasture(tx, paddockId));
  return json({ pasture });
});
