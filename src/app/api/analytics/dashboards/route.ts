import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { createDashboard, listDashboards } from "@/lib/analytics/dashboards";
import { requireAnalytics } from "@/lib/analytics/sources";

export const GET = route(async (request) => {
  const dashboards = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    await requireAnalytics(tx);
    return listDashboards(tx);
  });
  return json({ dashboards });
});

/** A new dashboard (name, description, settings, tiles). Bookkeepers and up. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const dashboard = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) => createDashboard(tx, body));
  return json({ dashboard }, { status: 201 });
});
