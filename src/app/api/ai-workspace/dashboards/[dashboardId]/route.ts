import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { archiveAiDashboard, getAiDashboard } from "@/lib/ai-workspace/dashboards";

type Context = { params: Promise<{ dashboardId: string }> };

/** A dashboard with each tile's figures. */
export const GET = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const dashboard = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => getAiDashboard(tx, dashboardId));
  return json({ dashboard });
});

/** Archives a dashboard. Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => archiveAiDashboard(tx, dashboardId));
  return json({ archived: true });
});
