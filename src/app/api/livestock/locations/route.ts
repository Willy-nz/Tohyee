import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createLocation, listLocations } from "@/lib/livestock/movements";

/** GET: farms, blocks and grazing places stock can be at (LV3). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const locations = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listLocations(tx));
  return json({ locations });
});

/** Adds a location. Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const location = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createLocation(tx, { name: body.name }));
  return json({ location }, { status: 201 });
});
