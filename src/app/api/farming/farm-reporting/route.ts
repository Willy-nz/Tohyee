import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getFarmReportingSetup, linkFarmTrackingValue, setFarmTrackingCategory } from "@/lib/farming/farm-reporting";

/** GET: the tracking category that carries the farm, its values and each farm's link (FR1). */
export const GET = route(async (request) => {
  const setup = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getFarmReportingSetup(tx));
  return json({ setup });
});

/** PUT: chooses the category (`categoryId`, or null for none). Bookkeepers and above, as for working-expense groups. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setFarmTrackingCategory(tx, { categoryId: body.categoryId }));
  return json({ setup });
});

/** PATCH: links a farm to a value (`farmId`, `valueId`, or null to unlink). Bookkeepers and above. */
export const PATCH = route(async (request) => {
  const body = await readJson(request);
  const setup = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => linkFarmTrackingValue(tx, { farmId: body.farmId, valueId: body.valueId }));
  return json({ setup });
});
