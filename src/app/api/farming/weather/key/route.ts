import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { removeWeatherKey, saveWeatherKey } from "@/lib/weather/service";

/** PUT: saves the organisation's MetService key, encrypted (decision 1542). Admins. The answer never has the key. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "admin", (tx) => saveWeatherKey(tx, body.key));
  return json({ setup });
});

/** DELETE: removes the key; the forecast stops and the kept forecast is deleted. Admins. */
export const DELETE = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", (tx) => removeWeatherKey(tx));
  return json({ setup });
});
