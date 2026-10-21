import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { columnValues, getDashboard, slicerPairs, type Tile } from "@/lib/analytics/dashboards";
import { requireAnalyticsTable } from "@/lib/analytics/farm-access";
import { requireAnalytics } from "@/lib/analytics/sources";
import { ForbiddenError } from "@/lib/errors";

/**
 * The values a slicer offers (up to 500), and the column's type. Report viewers (decision 360) only
 * for a slicer on a dashboard shared with them (`dashboardId`).
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const table = params.get("table") ?? "";
  const field = params.get("field") ?? "";
  // A hierarchy slicer asks for its pairs with `child` (decision 757).
  const child = params.get("child");
  let viewerTiles: Tile[] | undefined;
  const organisationId = await withOrganisation(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    if (!roleAtLeast(membership.role, "viewer")) {
      const dashboard = await getDashboard(tx, params.get("dashboardId") ?? "", { userId: auth.user.id, reportViewer: true });
      if (!dashboard.settings.slicers.some((slicer) => slicer.table === table && slicer.field === field && (!child || (slicer.style === "hierarchy" && slicer.child === child)))) {
        throw new ForbiddenError("You can only see the dashboards shared with you.");
      }
      viewerTiles = dashboard.tiles;
    }
    await requireAnalyticsTable(tx, table);
    return tx.organisationId;
  });
  if (child) return json({ pairs: await slicerPairs(organisationId, table, field, child, viewerTiles) });
  return json(await columnValues(organisationId, table, field));
});
