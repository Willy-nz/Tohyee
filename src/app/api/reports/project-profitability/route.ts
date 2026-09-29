import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { projectProfitability } from "@/lib/projects/service";

/** GET: each project's invoiced, costs, profit, unbilled and estimate (PJ9); `status` filters. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const report = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => projectProfitability(tx, { status: params.get("status") }));
  return json({ report });
});
