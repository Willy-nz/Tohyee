import { json, readJson, route, searchParams, withOrganisation, withFarmWork } from "@/lib/api/http";
import { getFarmingSettings, setFarmingEnabled, setImageryKey } from "@/lib/farming/paddocks";

/** GET: whether Farming is on (#249). */
export const GET = route(async (request) => {
  const settings = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => getFarmingSettings(tx));
  return json({ settings });
});

/**
 * Turns Farming on or off (`enabled`; it needs Accounting), or sets or clears
 * the LINZ Basemaps key for aerial imagery (`imageryKey`). Admins.
 */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    "imageryKey" in body ? setImageryKey(tx, { imageryKey: body.imageryKey }) : setFarmingEnabled(tx, { enabled: body.enabled }),
  );
  return json({ settings });
});
