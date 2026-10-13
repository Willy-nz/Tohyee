import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getFarmingSettings, setFarmingEnabled } from "@/lib/farming/paddocks";

/** GET: whether Farming is on (#249). */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getFarmingSettings(tx));
  return json({ settings });
});

/** Turns Farming on or off (`enabled`). Admins; it needs Accounting. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => setFarmingEnabled(tx, { enabled: body.enabled }));
  return json({ settings });
});
