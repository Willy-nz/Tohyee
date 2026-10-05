import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { todayIsoDate } from "@/lib/dates";
import { getEcbSettings, updateEcbSettings } from "@/lib/fx/ecb";

/** GET: whether ECB rates come in (FX1), for which currencies, and the last check. Viewers and above. */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getEcbSettings(tx));
  return json({ settings });
});

/** PUT `{ enabled, extraCurrencies }`: turns ECB rates on or off. Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => updateEcbSettings(tx, body, todayIsoDate()));
  return json({ settings });
});
