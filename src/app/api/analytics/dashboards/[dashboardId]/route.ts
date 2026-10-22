import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { deleteDashboard, updateDashboard } from "@/lib/analytics/dashboards";
import { dashboardRead } from "@/lib/analytics/read-routes";

type Context = { params: Promise<{ dashboardId: string }> };

// Today and the balance date come too, for the date presets (decision 577).
export const GET = route<Context>(dashboardRead(withOrganisation));

export const PATCH = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  const body = await readJson(request);
  const dashboard = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => updateDashboard(tx, dashboardId, body));
  return json({ dashboard });
});

export const DELETE = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => deleteDashboard(tx, dashboardId));
  return json({ ok: true });
});
