import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { dropWeatherAnalytics } from "@/lib/weather/analytics-drop";
import { getWeatherSetup, saveSetupStep, saveWeatherChoices, saveWeatherLocations, setCombine, setWeatherEnabled } from "@/lib/weather/service";

/** GET: the MetService forecast setup (decision 1541). Admins. Never the key. */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => getWeatherSetup(tx));
  return json({ setup });
});

/**
 * PATCH: one change to the setup (admins): `step` (where the setup is up
 * to), `choices` and `refreshHours`, `locations` (the farms and their pins),
 * `enabled`, or `combine` (the second permission switch).
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => {
    if ("locations" in body) return saveWeatherLocations(tx, body.locations);
    if ("choices" in body || "refreshHours" in body) return saveWeatherChoices(tx, { choices: body.choices, refreshHours: body.refreshHours });
    if ("enabled" in body) return setWeatherEnabled(tx, body.enabled);
    if ("combine" in body) return setCombine(tx, body.combine);
    return saveSetupStep(tx, body.step);
  });
  if (!setup.permission.combine) await dropWeatherAnalytics(String(body.organisationId));
  return json({ setup });
});
