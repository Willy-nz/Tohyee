import { json, readJson, route, searchParams, withOrganisation, withFarmWork } from "@/lib/api/http";
import { listFarms, saveFarm } from "@/lib/farming/paddocks";

/** GET: the organisation's farms, with their paddock counts and areas. */
export const GET = route(async (request) => {
  const farms = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => listFarms(tx));
  return json({ farms });
});

/** Adds a farm, or changes one (`id`). Bookkeepers and above. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const farms = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => saveFarm(tx, { id: body.id, name: body.name, notes: body.notes, isActive: body.isActive }));
  return json({ farms });
});
