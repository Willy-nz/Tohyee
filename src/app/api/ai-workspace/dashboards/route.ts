import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listAiDashboards } from "@/lib/ai-workspace/dashboards";

/** Dashboards over the AI's tables (AIW7). */
export const GET = route(async (request) => {
  const dashboards = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listAiDashboards(tx));
  return json({ dashboards });
});
