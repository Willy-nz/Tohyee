import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listManagementValues, setManagementValues } from "@/lib/livestock/management";

/** GET: the farm's values per head by class, from a month on. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const values = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listManagementValues(tx));
  return json({ values });
});

/** Sets values per head from a month on; a blank amount removes that month's value. Never touches tax values (LV20). Bookkeepers and above. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const values = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => setManagementValues(tx, { effectiveMonth: body.effectiveMonth, lines: body.lines }));
  return json({ values });
});
