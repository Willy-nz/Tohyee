import { getDashboardPreference, saveDashboardPreference } from "@/lib/dashboard/preferences";
import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listDashboards } from "@/lib/analytics/dashboards";
import { analyticsTileReference, parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { dashboardPage, defaultDashboardTileIds } from "@/lib/dashboard/pages";
import { NotFoundError, ValidationError } from "@/lib/errors";

async function allowedTiles(
  tx: Parameters<Parameters<typeof withOrganisation>[3]>[0],
  page: string,
  userId: string,
  role: string,
): Promise<readonly string[]> {
  const definition = dashboardPage(page);
  if (!definition) return [];
  const defaults = defaultDashboardTileIds(definition);
  const settings = await tx.query<{ analytics_enabled: boolean }>("select analytics_enabled from organisation_settings where id = true");
  if (settings.rows[0]?.analytics_enabled !== true) return defaults;
  const dashboards = await listDashboards(tx, { userId, reportViewer: role === "report_viewer" });
  return [
    ...defaults,
    ...dashboards.flatMap((dashboard) => dashboard.tiles.map((tile) => analyticsTileReference(dashboard.id, tile.id))),
  ];
}

function checkAnalyticsTiles(input: unknown, allowed: readonly string[]) {
  if (!Array.isArray(input)) return;
  const allowedSet = new Set(allowed);
  for (const value of input) {
    if (typeof value !== "string" || !value.startsWith("analytics:")) continue;
    if (!parseAnalyticsTileReference(value)) throw new ValidationError("That Analytics tile reference isn't valid.");
    if (!allowedSet.has(value)) throw new NotFoundError("That Analytics tile wasn't found.");
  }
}

export const GET = route(async (request) => {
  const params = searchParams(request);
  const page = params.get("page") ?? "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await withOrganisation(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    const defaults = defaultDashboardTileIds(definition);
    const allowed = await allowedTiles(tx, page, auth.user.id, membership.role);
    return getDashboardPreference(tx, { userId: auth.user.id, page, defaultTiles: defaults, allowedTiles: allowed });
  });
  return json(preference);
});

export const PUT = route(async (request) => {
  const body = await readJson(request);
  const page = typeof body.page === "string" ? body.page : "";
  const definition = dashboardPage(page);
  if (!definition) return json({ error: "Unknown dashboard page." }, { status: 404 });
  const preference = await withOrganisation(request, body.organisationId, "report_viewer", async (tx, { auth, membership }) => {
    const defaults = defaultDashboardTileIds(definition);
    const allowed = await allowedTiles(tx, page, auth.user.id, membership.role);
    checkAnalyticsTiles(body.tiles, allowed);
    return saveDashboardPreference(tx, {
      userId: auth.user.id,
      page,
      hidden: body.hidden,
      tiles: body.tiles,
      defaultTiles: defaults,
      allowedTiles: allowed,
    });
  });
  return json(preference);
});
