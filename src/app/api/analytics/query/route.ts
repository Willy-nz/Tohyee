import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { roleAtLeast } from "@/lib/auth/roles";
import { allowedFilters, dateContext, getDashboard, runPivotDrilldown, runTile, tileOf } from "@/lib/analytics/dashboards";
import type { DashboardFilters, TileQuery } from "@/lib/analytics/query";
import { parseTileView, viewQuery, type TileDrill } from "@/lib/analytics/report-view";
import { requireAnalyticsTable } from "@/lib/analytics/farm-access";
import { requireAnalytics } from "@/lib/analytics/sources";
import { loadModel } from "@/lib/analytics/model";
import { applyChoice, draftParameterValues, parameterValues, parseChoice } from "@/lib/analytics/parameters";
import { reportPages, tilePage } from "@/lib/analytics/pages";
import { effectiveDates } from "@/lib/analytics/report-filters";
import { parseRanges, rangeFilters, slicerOnPage } from "@/lib/analytics/slicers";
import { FILTER_OPS } from "@/lib/analytics/filters";
import type { Filter } from "@/lib/analytics/query";
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
 * More filters for a question being built (viewers and up, who can ask any
 * question anyway): a draft tile's page filters and range slicers, worked
 * out in the browser. Only known tests; each is checked against the
 * column's type when the SQL is built.
 */
function extraFilters(input: unknown): Filter[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 20).flatMap((entry) => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (typeof raw.field !== "string" || !FILTER_OPS.includes(raw.op as Filter["op"])) return [];
    const op = raw.op as Filter["op"];
    const list = op === "in" || op === "not_in" || op === "between";
    if (list !== Array.isArray(raw.value) || (op === "between" && (raw.value as unknown[]).length !== 2)) return [];
    if ((op === "last_days" || op === "last_months") && !/^\d{1,4}$/.test(String(raw.value))) return [];
    const value = Array.isArray(raw.value) ? raw.value.slice(0, 200).map(String) : String(raw.value ?? "");
    return [{ field: raw.field, op, value }];
  });
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
  // What-if parameters' values (decision 773): checked against the report's own sliders for a saved tile.
  const rawParameters = ((body.filters ?? {}) as Record<string, unknown>).parameters;
  // The organisation's calculated fields (decision 772) are read with the question, so tiles can use them.
  const { organisationId, query, fields } = await withOrganisation(request, body.organisationId, "report_viewer", async (tx, { auth, membership }) => {
    await requireAnalytics(tx);
    const reader = { userId: auth.user.id, reportViewer: membership.role === "report_viewer" };
    // Today and the balance date, for filters like "in this financial year" (decision 578).
    const dates = await dateContext(tx);
    // Drilling, clicks and drill-through (decision 756): worked out from the report's saved tiles, only narrowing.
    const view = parseTileView(body.view);
    if (body.dashboardId !== undefined) {
      const dashboard = await getDashboard(tx, String(body.dashboardId), reader);
      // The reader's switches (decision 773): only the saved tile's own choices, by position.
      const saved = tileOf(dashboard, body.tileId);
      const tile = saved.query ? { ...saved, query: applyChoice(saved.query, saved.switches, parseChoice(body.choice)) } : saved;
      await requireAnalyticsTable(tx, (tile.query as { table?: unknown } | null | undefined)?.table);
      const viewed = viewQuery(dashboard.tiles.map((entry) => (entry.id === tile.id ? tile : entry)), tile, view);
      // The tile's page: its slicers' ranges and its own filters (decisions 757-758), from the report as saved.
      const pageId = tilePage(tile, dashboard.settings.pages);
      const page = reportPages(dashboard.settings.pages).find((entry) => entry.id === pageId);
      const ranges = rangeFilters(dashboard.settings.slicers.filter((slicer) => slicerOnPage(slicer, pageId)), parseRanges((body.filters as Record<string, unknown> | undefined)?.ranges));
      const allowed = allowedFilters(dashboard, filters, reader);
      // A tile with its own dates ignores the report's (decision 758).
      const own = effectiveDates(tile.dates, allowed, dates.today, dates.yearEndMonth);
      // A table with a totals row gets the whole answer as one total too (decision 694).
      const totals = tile.visual === "table" && tile.format?.table?.totals === true;
      return {
        organisationId: tx.organisationId,
        query: {
          tile: { query: viewed.query },
          filters: { ...allowed, ...own, dates, view: [...viewed.where, ...ranges, ...(page?.filters ?? []).map((entry) => entry.filter)], parameters: parameterValues(dashboard.settings.parameters, rawParameters) },
          totals,
        },
        fields: await loadModel(tx),
      };
    }
    if (!roleAtLeast(membership.role, "viewer")) throw new ForbiddenError("You can only see the dashboards shared with you.");
    await requireAnalyticsTable(tx, (body.query as { table?: unknown } | undefined)?.table);
    // A question being built (viewers and up, who can ask any question): the other tiles are the ones sent, as drawn.
    if (view) {
      const tiles = (Array.isArray(body.viewTiles) ? body.viewTiles : []).slice(0, 40) as Parameters<typeof viewQuery>[0];
      const viewed = viewQuery(tiles, { id: String(body.tileId ?? "draft"), title: "This tile", query: body.query as TileQuery, drill: body.viewDrill as TileDrill | undefined }, view);
      return { organisationId: tx.organisationId, query: { tile: { query: viewed.query }, filters: { ...filters, dates, view: [...viewed.where, ...extraFilters(body.where)], parameters: draftParameterValues(rawParameters) }, totals: body.totals === true }, fields: await loadModel(tx) };
    }
    return { organisationId: tx.organisationId, query: { tile: { query: body.query }, filters: { ...filters, dates, view: extraFilters(body.where), parameters: draftParameterValues(rawParameters) }, totals: body.totals === true }, fields: await loadModel(tx) };
  });
  if (body.drill !== undefined) return json(await runPivotDrilldown(organisationId, query.tile.query, query.filters, body.drill, fields));
  return json(await runTile(organisationId, query.tile.query, query.filters, { totals: query.totals, model: fields }));
});
