import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { archiveLocation } from "@/lib/livestock/movements";

type Context = { params: Promise<{ locationId: string }> };

/** Archives (`archived: true`) or restores a location. Bookkeepers and above. */
export const PATCH = route<Context>(async (request, context) => {
  const { locationId } = await context.params;
  const body = await readJson(request);
  const location = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => archiveLocation(tx, locationId, body.archived !== false));
  return json({ location });
});
