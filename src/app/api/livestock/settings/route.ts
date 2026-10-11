import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getLivestockSettings, updateLivestockSettings } from "@/lib/livestock/movements";

/** GET: whether livestock is on and its first income year (#221). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const settings = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getLivestockSettings(tx));
  return json({ settings });
});

/** Turns livestock on or off and sets the first income year. Admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateLivestockSettings(tx, { enabled: body.enabled, firstYearStart: body.firstYearStart }),
  );
  return json({ settings });
});
