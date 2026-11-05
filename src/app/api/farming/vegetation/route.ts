import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { demoProviderAllowed } from "@/lib/farming/vegetation/http";
import { getVegetationSettings, updateVegetationSettings } from "@/lib/farming/vegetation/service";

/** GET: satellite vegetation's connection, limits, this month's use and the last test (owners and admins; never the secret). */
export const GET = route(async (request) => {
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "admin", async (tx, { membership }) => ({
    settings: await getVegetationSettings(tx),
    demoAllowed: demoProviderAllowed(membership.organisation),
  }));
  return json(result);
});

/** Changes limits and thresholds, turns it on or off, or carries on after a pause (`resume: true`). Owners and admins. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => updateVegetationSettings(tx, body));
  return json({ settings });
});
