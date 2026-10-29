import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { farmLocations, startSharing } from "@/lib/farming/locations";

type Context = { params: Promise<{ farmId: string }> };

/*
 * Farm members on the map (#498 item 7, decisions 1125-1134). Only members
 * who work on this farm (decision 744) reach it; another farm or
 * organisation is "not found".
 */

/** GET: who is sharing their location with this farm, each with only their latest position. */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const result = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => farmLocations(tx, farmId));
  return json(result);
});

/** POST: the signed-in person starts sharing their location with this farm for `hours` (1-12, default 4). */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const sharing = await withFarmWork(request, body.organisationId, "read", (tx) => startSharing(tx, { farmId, hours: body.hours }));
  return json({ sharing }, { status: 201 });
});
