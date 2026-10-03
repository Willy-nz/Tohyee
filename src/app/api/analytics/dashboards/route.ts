import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createDashboard, listDashboards } from "@/lib/analytics/dashboards";
import { requireAnalytics } from "@/lib/analytics/sources";

/** The dashboards someone can see: all of them, or for a report viewer only those shared with them (decision 360). */
export const GET = route(async (request) => {
  const dashboards = await withOrganisation(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    return listDashboards(tx, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
  });
  return json({ dashboards });
});

/** A new dashboard (name, description, settings, tiles). Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const dashboard = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createDashboard(tx, body));
  return json({ dashboard }, { status: 201 });
});
