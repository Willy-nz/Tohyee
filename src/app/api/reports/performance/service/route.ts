import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getServicePerformance, saveServicePerformance } from "@/lib/reports/performance-report";

/** The statement of service performance for the year ending `yearEnd` (NPR9). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const service = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getServicePerformance(tx, params.get("yearEnd")));
  return json(service);
});

/** Saves the year's activities and measures; an empty list removes them. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const service = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => saveServicePerformance(tx, { yearEnd: body.yearEnd, activities: body.activities }));
  return json(service);
});
