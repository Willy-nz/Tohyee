import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getFixedAssetSettings, updateFixedAssetSettings } from "@/lib/fixed-assets/service";

/** GET: how part months are counted (FA7, FA8) and the financial year end. */
export const GET = route(async (request) => {
  const settings = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getFixedAssetSettings(tx));
  return json({ settings });
});

/** Changes `firstMonth` (full_month or next_month) and `disposalMonth` (include or exclude). Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) =>
    updateFixedAssetSettings(tx, { firstMonth: body.firstMonth, disposalMonth: body.disposalMonth }),
  );
  return json({ settings });
});
