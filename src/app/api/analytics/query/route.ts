import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { allowedFilters, dateContext, getDashboard, runPivotDrilldown, runTile, tileOf } from "@/lib/analytics/dashboards";
import type { DashboardFilters } from "@/lib/analytics/query";
import { requireAnalyticsTable } from "@/lib/analytics/farm-access";
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
    if (body.dashboardId !== undefined) {
      const dashboard = await getDashboard(tx, String(body.dashboardId), reader);
      const tile = tileOf(dashboard, body.tileId);
      await requireAnalyticsTable(tx, (tile.query as { table?: unknown } | undefined)?.table);
      // A table with a totals row gets the whole answer as one total too (decision 694).
      const totals = tile.visual === "table" && tile.format?.table?.totals === true;
      return { organisationId: tx.organisationId, query: { tile, filters: { ...allowedFilters(dashboard, filters, reader), dates }, totals } };
    }
    if (!roleAtLeast(membership.role, "viewer")) throw new ForbiddenError("You can only see the dashboards shared with you.");
    await requireAnalyticsTable(tx, (body.query as { table?: unknown } | undefined)?.table);
    return { organisationId: tx.organisationId, query: { tile: { query: body.query }, filters: { ...filters, dates }, totals: body.totals === true } };
  });
  if (body.drill !== undefined) return json(await runPivotDrilldown(organisationId, query.tile.query, query.filters, body.drill));
  return json(await runTile(organisationId, query.tile.query, query.filters, { totals: query.totals }));
});
