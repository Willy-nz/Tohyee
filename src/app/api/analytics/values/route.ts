import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { columnValues, dateContext, getDashboard, slicerValuesFor, type Dashboard } from "@/lib/analytics/dashboards";
import { hiddenFarmTables, requireAnalyticsTable } from "@/lib/analytics/farm-access";
import type { QueryDates } from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";
import { ForbiddenError } from "@/lib/errors";

/**
 * The values a slicer offers (up to 500), and the column's type. Report viewers (decision 360) only
 * for a slicer on a dashboard shared with them (`dashboardId`), and only values that report's tiles
 * can show (decision 697), not the whole table's.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const table = params.get("table") ?? "";
  const field = params.get("field") ?? "";
  const { organisationId, scoped } = await withOrganisation(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    let scoped: { dashboard: Dashboard; dates: QueryDates; skip: string[] } | null = null;
    if (!roleAtLeast(membership.role, "viewer")) {
      const dashboard = await getDashboard(tx, params.get("dashboardId") ?? "", { userId: auth.user.id, reportViewer: true });
      if (!dashboard.settings.slicers.some((slicer) => slicer.table === table && slicer.field === field)) {
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
    return { organisationId: tx.organisationId, scoped };
  });
  if (scoped) return json(await slicerValuesFor(organisationId, scoped.dashboard, field, scoped.dates, new Set(scoped.skip)));
  return json(await columnValues(organisationId, table, field));
});
