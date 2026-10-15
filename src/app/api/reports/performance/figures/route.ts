import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { performanceFigures } from "@/lib/reports/performance-report";

/** This year's and last year's performance report figures by category (NPR1-NPR5). Viewers and above. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const figures = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => performanceFigures(tx, params.get("yearEnd")));
  return json(figures);
});
