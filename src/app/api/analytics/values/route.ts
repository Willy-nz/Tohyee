import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { columnValues, dateContext, getDashboard, slicerPairs, slicerValuesFor, type Dashboard } from "@/lib/analytics/dashboards";
import { hiddenFarmTables, requireAnalyticsTable } from "@/lib/analytics/farm-access";
import type { QueryDates } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";
import { loadModel } from "@/lib/analytics/model";
import { ForbiddenError } from "@/lib/errors";

/**
 * The values a slicer offers (up to 500), and the column's type. Report viewers (decision 360) only
 * for a slicer on a dashboard shared with them (`dashboardId`), and only values that report's tiles
 * can show (decision 697), not the whole table's. With `child`, a two-level slicer's pairs
 * (decision 757), scoped the same way.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const table = params.get("table") ?? "";
  const field = params.get("field") ?? "";
  const child = params.get("child");
  const { organisationId, scoped, fields } = await withOrganisation(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    let scoped: { dashboard: Dashboard; dates: QueryDates; skip: string[] } | null = null;
    if (!roleAtLeast(membership.role, "viewer")) {
      const dashboard = await getDashboard(tx, params.get("dashboardId") ?? "", { userId: auth.user.id, reportViewer: true });
      if (!dashboard.settings.slicers.some((slicer) => slicer.table === table && slicer.field === field && (!child || (slicer.style === "hierarchy" && slicer.child === child)))) {
        throw new ForbiddenError("You can only see the dashboards shared with you.");
      }
      const context = await dateContext(tx);
      scoped = { dashboard, dates: { today: context.today, yearEndMonth: context.yearEndMonth }, skip: [] };
    }
    await requireAnalyticsTable(tx, table);
    if (scoped) {
      // Tiles on farm tables this person can't use (decision 744) don't offer their values either.
      const hidden = await hiddenFarmTables(tx);
      if (hidden) scoped.skip = scoped.dashboard.tiles.flatMap((tile) => (tile.query && hidden.has(tile.query.table) ? [tile.query.table] : []));
    }
    // Calculated fields (decision 772) can be slicers too.
    return { organisationId: tx.organisationId, scoped, fields: await loadModel(tx) };
  });
  if (child) {
    const tiles = scoped ? scoped.dashboard.tiles.filter((tile) => !tile.query || !scoped.skip.includes(tile.query.table)) : undefined;
    return json({ pairs: await slicerPairs(organisationId, table, field, child, tiles, scoped?.dates, fields) });
  }
  if (scoped) return json(await slicerValuesFor(organisationId, scoped.dashboard, field, scoped.dates, new Set(scoped.skip), fields));
  return json(await columnValues(organisationId, table, field, fields));
});
