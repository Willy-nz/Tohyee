import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { allowedFilters, dateContext, getDashboard, runPivotDrilldown, runTile, tileOf } from "@/lib/analytics/dashboards";
import type { DashboardFilters, TileQuery } from "@/lib/analytics/query";
import { parseTileView, viewQuery, type TileDrill } from "@/lib/analytics/report-view";
import { requireAnalytics } from "@/lib/analytics/sources";
import { ForbiddenError } from "@/lib/errors";

function parseFilters(raw: Record<string, unknown>): DashboardFilters {
  const values: Record<string, string[]> = {};
  if (raw.values && typeof raw.values === "object") {
    for (const [field, list] of Object.entries(raw.values as Record<string, unknown>)) {
      if (Array.isArray(list)) values[field] = list.map(String);
    }
  }
  return {
    from: typeof raw.from === "string" && raw.from ? raw.from : null,
    to: typeof raw.to === "string" && raw.to ? raw.to : null,
    values,
  };
}

/**
 * Answers a tile's question. With `dashboardId` and `tileId`, the saved
 * question of that tile is run, which is all a report viewer may do (decision
 * 360), with only the dashboard's own slicers. Otherwise `query` is any
 * question (viewers and up, e.g. a tile being built).
 */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const filters = parseFilters((body.filters ?? {}) as Record<string, unknown>);
  const { organisationId, query } = await withOrganisation(request, body.organisationId, "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    const reader = { userId: auth.user.id, reportViewer: membership.role === "report_viewer" };
    // Today and the balance date, for filters like "in this financial year" (decision 578).
    const dates = await dateContext(tx);
    // Drilling, clicks and drill-through (decision 756): worked out from the report's saved tiles, only narrowing.
    const view = parseTileView(body.view);
    if (body.dashboardId !== undefined) {
      const dashboard = await getDashboard(tx, String(body.dashboardId), reader);
      const tile = tileOf(dashboard, body.tileId);
      const viewed = viewQuery(dashboard.tiles, tile, view);
      return { organisationId: tx.organisationId, query: { tile: { query: viewed.query }, filters: { ...allowedFilters(dashboard, filters, reader), dates, view: viewed.where } } };
    }
    if (!roleAtLeast(membership.role, "viewer")) throw new ForbiddenError("You can only see the dashboards shared with you.");
    // A question being built (viewers and up, who can ask any question): the other tiles are the ones sent, as drawn.
    if (view) {
      const tiles = (Array.isArray(body.viewTiles) ? body.viewTiles : []).slice(0, 40) as Parameters<typeof viewQuery>[0];
      const viewed = viewQuery(tiles, { id: String(body.tileId ?? "draft"), title: "This tile", query: body.query as TileQuery, drill: body.viewDrill as TileDrill | undefined }, view);
      return { organisationId: tx.organisationId, query: { tile: { query: viewed.query }, filters: { ...filters, dates, view: viewed.where } } };
    }
    return { organisationId: tx.organisationId, query: { tile: { query: body.query }, filters: { ...filters, dates } } };
  });
  if (body.drill !== undefined) return json(await runPivotDrilldown(organisationId, query.tile.query, query.filters, body.drill));
  return json(await runTile(organisationId, query.tile.query, query.filters));
});
