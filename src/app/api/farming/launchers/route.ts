import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { addLauncher, listLaunchers } from "@/lib/farming/launchers";

/** GET: the farm app tiles for the farms you work on (name and address only; decision 908). Farm staff too. */
export const GET = route(async (request) => {
  const launchers = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => listLaunchers(tx));
  return json({ launchers });
});

/** POST `{ name, url, description?, farmId? }`: adds a tile. Admins. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const launchers = await withOrganisation(request, body.organisationId, "admin", (tx) => addLauncher(tx, { name: body.name, url: body.url, description: body.description, farmId: body.farmId }));
  return json({ launchers }, { status: 201 });
});
