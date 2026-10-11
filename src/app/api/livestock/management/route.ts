import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { managementReport } from "@/lib/livestock/management";

/** GET: stock on hand at the farm's own values per head at each month end of the year ending `yearEnd` (LV18, LV19). A report: it posts nothing. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => managementReport(tx, { yearEnd: params.get("yearEnd") }));
  return json({ report });
});
