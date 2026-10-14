import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listDatasets } from "@/lib/ai-workspace/datasets";

/** The AI's tables (AIW5). */
export const GET = route(async (request) => {
  const datasets = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => listDatasets(tx));
  return json({ datasets });
});
