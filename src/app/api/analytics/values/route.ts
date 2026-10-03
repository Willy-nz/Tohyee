import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { getDashboard, sliceValues } from "@/lib/analytics/dashboards";
import { requireAnalytics } from "@/lib/analytics/sources";
import { ForbiddenError } from "@/lib/errors";

/**
 * The values a slicer offers (up to 500). Report viewers (decision 360) only
 * for a slicer on a dashboard shared with them (`dashboardId`).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const table = params.get("table") ?? "";
  const field = params.get("field") ?? "";
  const organisationId = await withOrganisation(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    if (!roleAtLeast(membership.role, "viewer")) {
      const dashboard = await getDashboard(tx, params.get("dashboardId") ?? "", { userId: auth.user.id, reportViewer: true });
      if (!dashboard.settings.slicers.some((slicer) => slicer.table === table && slicer.field === field)) {
        throw new ForbiddenError("You can only see the dashboards shared with you.");
      }
    }
    return tx.organisationId;
  });
  return json({ values: await sliceValues(organisationId, table, field) });
});
