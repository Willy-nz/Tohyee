import { route, searchParams, withOrganisation } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { getDashboard } from "@/lib/analytics/dashboards";
import { readDashboardImage } from "@/lib/analytics/images";
import { requireAnalytics } from "@/lib/analytics/sources";

type Context = { params: Promise<{ dashboardId: string; imageId: string }> };

/**
 * GET: one of a report's images, only for people who can see the report
 * (a report viewer only when it's shared with them, decision 360), the same
 * check as reading the report itself.
 */
export const GET = route<Context>(async (request, context) => {
  const { dashboardId, imageId } = await context.params;
  const image = await withOrganisation(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    const dashboard = await getDashboard(tx, dashboardId, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
    return readDashboardImage(tx, dashboard.id, imageId);
  });
  return fileResponse(image, false);
});
