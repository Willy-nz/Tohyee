import { listDashboards } from "@/lib/analytics/dashboards";
import { reportPages, tilePage } from "@/lib/analytics/pages";
import { requireAnalytics } from "@/lib/analytics/sources";
import { searchParams } from "@/lib/api/http";
import { json, officeRoute, withOfficeOrganisation } from "@/lib/office/api";

/**
 * GET ?organisationId: the reports the person can open (a report viewer only
 * those shared with them, decision 360), with their pages and tiles' names,
 * for choosing what goes on a slide (#429, decision 838). Only names: the
 * report itself is read when it's shown.
 */
export const GET = officeRoute(async (request) => {
  const reports = await withOfficeOrganisation(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    const dashboards = await listDashboards(tx, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
    return dashboards.map((dashboard) => ({
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description,
      pages: reportPages(dashboard.settings.pages).map((page) => ({ id: page.id, name: page.name })),
      tiles: dashboard.tiles
        .filter((tile) => tile.query !== null && tile.visual !== "button")
        .map((tile) => ({ id: tile.id, title: tile.title, visual: tile.visual, page: tilePage(tile, dashboard.settings.pages) })),
    }));
  });
  return json({ reports });
});
