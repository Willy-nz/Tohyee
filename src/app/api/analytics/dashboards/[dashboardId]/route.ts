import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { dateContext, deleteDashboard, getDashboard, updateDashboard } from "@/lib/analytics/dashboards";
import { requireAnalytics } from "@/lib/analytics/sources";

type Context = { params: Promise<{ dashboardId: string }> };

export const GET = route<Context>(async (request, context) => {
  const { dashboardId } = await context.params;
  // Today and the balance date come too, for the date presets (decision 577).
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    const dashboard = await getDashboard(tx, dashboardId, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
    const dates = await dateContext(tx);
    return { dashboard, today: dates.today, financialYearEndMonth: dates.yearEndMonth };
  });
  return json(result);
});

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
