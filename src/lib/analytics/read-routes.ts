import { json, readJson, searchParams } from "@/lib/api/http";
import { fileResponse } from "@/lib/api/upload";
import { roleAtLeast } from "@/lib/auth/roles";
import {
  allowedFilters,
  columnValues,
  type Dashboard,
  dateContext,
  getDashboard,
  runPivotDrilldown,
  runTile,
  slicerPairs,
  slicerValuesFor,
  tileOf,
} from "@/lib/analytics/dashboards";
import { runBuiltQuery } from "@/lib/analytics/engine";
import { hiddenFarmTables, requireAnalyticsTable } from "@/lib/analytics/farm-access";
import { FILTER_OPS } from "@/lib/analytics/filters";
import { combineFreshness, dataThroughSql, mayChangeSql, reportLoadFacts, tileDateFields } from "@/lib/analytics/freshness";
import { readDashboardImage } from "@/lib/analytics/images";
import { loadModel } from "@/lib/analytics/model";
import { reportPages, tilePage } from "@/lib/analytics/pages";
import { applyChoice, draftParameterValues, parameterValues, parseChoice } from "@/lib/analytics/parameters";
import type { DashboardFilters, Filter, QueryDates, TileQuery } from "@/lib/analytics/query";
import { effectiveDates } from "@/lib/analytics/report-filters";
import { parseTileView, type TileDrill, viewQuery } from "@/lib/analytics/report-view";
import { parseRanges, rangeFilters, slicerOnPage } from "@/lib/analytics/slicers";
import { requireAnalytics } from "@/lib/analytics/sources";
import { ForbiddenError } from "@/lib/errors";
import type { OrganisationRunner } from "@/lib/office/api";

/*
 * The Analytics reads a report needs to be shown (the report, its tiles'
 * answers, its slicers' values, its freshness and its images), as handlers
 * that take the organisation runner: `withOrganisation` for Tohyee's own
 * pages (signed in with a session) and `withOfficeOrganisation` for the
 * PowerPoint add-in (signed in with its token, read-only; #429, decision
 * 837). The same code answers both, so the add-in gets exactly what the
 * person gets in Tohyee, under the access contract (decision 697).
 */

type Context<P> = { params: Promise<P> };

/** GET a report, with today and the balance date for its date presets (decision 577). */
export function dashboardRead(run: OrganisationRunner) {
  return async (request: Request, context: Context<{ dashboardId: string }>) => {
    const { dashboardId } = await context.params;
    const result = await run(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
      await requireAnalytics(tx);
      const dashboard = await getDashboard(tx, dashboardId, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
      const dates = await dateContext(tx);
      return { dashboard, today: dates.today, financialYearEndMonth: dates.yearEndMonth };
    });
    return json(result);
  };
}

/**
 * How fresh a report's data is (decision 698): each source's last good load,
 * a failed or running refresh, and the latest date in the data its tiles go
 * by. Anyone who can open the report (report viewers only if it's shared
 * with them); no error text or file names, only times and dates.
 */
export function freshnessRead(run: OrganisationRunner) {
  return async (request: Request, context: Context<{ dashboardId: string }>) => {
    const { dashboardId } = await context.params;
    const { organisationId, dashboard, facts, hidden } = await run(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
      await requireAnalytics(tx);
      const dashboard = await getDashboard(tx, dashboardId, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
      // Farm tables this person can't use (decision 744): no date is read from them.
      const farm = await hiddenFarmTables(tx);
      const tables = dashboard.tiles.flatMap((tile) => (tile.query ? [tile.query.table] : []));
      return { organisationId: tx.organisationId, dashboard, facts: await reportLoadFacts(tx, dashboard), hidden: new Set(farm ? tables.filter((table) => farm.has(table)) : []) };
    });
    // The latest dates are read from the analytics file, outside the transaction.
    const through = new Map<string, string | null>();
    const changing = new Map<string, string | null>();
    for (const table of facts.flatMap((fact) => fact.tables)) {
      if (hidden.has(table)) continue;
      // Search Console's newest days may still change (decision 1183).
      const changingSql = mayChangeSql(table);
      if (changingSql) {
        try {
          changing.set(table, (await runBuiltQuery(organisationId, changingSql, []))[0]?.changing ?? null);
        } catch {
          changing.set(table, null);
        }
      }
      const sql = dataThroughSql(table, tileDateFields(dashboard, table));
      if (!sql) continue;
      try {
        through.set(table, (await runBuiltQuery(organisationId, sql, []))[0]?.through ?? null);
      } catch {
        // A table that's gone or changed: its tiles say so themselves.
        through.set(table, null);
      }
    }
    return json(combineFreshness(facts, through, changing));
  };
}

/** GET one of a report's images, only for people who can see the report (a report viewer only when it's shared with them, decision 360). */
export function imageRead(run: OrganisationRunner) {
  return async (request: Request, context: Context<{ dashboardId: string; imageId: string }>) => {
    const { dashboardId, imageId } = await context.params;
    const image = await run(request, searchParams(request).get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
      await requireAnalytics(tx);
      const dashboard = await getDashboard(tx, dashboardId, { userId: auth.user.id, reportViewer: membership.role === "report_viewer" });
      return readDashboardImage(tx, dashboard.id, imageId);
    });
    return fileResponse(image, false);
  };
}

/**
 * The values a slicer offers (up to 500), and the column's type. Report viewers (decision 360) only
 * for a slicer on a dashboard shared with them (`dashboardId`), and only values that report's tiles
 * can show (decision 697), not the whole table's. With `child`, a two-level slicer's pairs
 * (decision 757), scoped the same way. With `reportOnly` (the PowerPoint add-in), everyone is
 * asked for the report's slicer, as a report viewer is.
 */
export function valuesRead(run: OrganisationRunner, options: { reportOnly?: boolean } = {}) {
  return async (request: Request) => {
    const params = searchParams(request);
    const table = params.get("table") ?? "";
    const field = params.get("field") ?? "";
    const child = params.get("child");
    const { organisationId, scoped, fields } = await run(request, params.get("organisationId"), "report_viewer", async (tx, { auth, membership }) => {
      await requireAnalytics(tx);
      let scoped: { dashboard: Dashboard; dates: QueryDates; skip: string[]; reportViewer: boolean } | null = null;
      const reportViewer = !roleAtLeast(membership.role, "viewer");
      if (reportViewer || options.reportOnly) {
        const dashboard = await getDashboard(tx, params.get("dashboardId") ?? "", { userId: auth.user.id, reportViewer });
        if (!dashboard.settings.slicers.some((slicer) => slicer.table === table && slicer.field === field && (!child || (slicer.style === "hierarchy" && slicer.child === child)))) {
          throw new ForbiddenError("You can only see the dashboards shared with you.");
        }
        const context = await dateContext(tx);
        scoped = { dashboard, dates: { today: context.today, yearEndMonth: context.yearEndMonth }, skip: [], reportViewer };
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
    // Viewers and up get the whole column, as in Tohyee (they can query the table anyway); report viewers what the report shows.
    const limited = scoped?.reportViewer ? scoped : null;
    if (child) {
      const tiles = limited ? limited.dashboard.tiles.filter((tile) => !tile.query || !limited.skip.includes(tile.query.table)) : undefined;
      return json({ pairs: await slicerPairs(organisationId, table, field, child, tiles, limited?.dates, fields) });
    }
    if (limited) return json(await slicerValuesFor(organisationId, limited.dashboard, field, limited.dates, new Set(limited.skip), fields));
    return json(await columnValues(organisationId, table, field, fields));
  };
}

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
 * question (viewers and up, e.g. a tile being built), except with
 * `savedOnly` (the PowerPoint add-in, decision 837), where only saved tiles run.
 */
export function queryRead(run: OrganisationRunner, options: { savedOnly?: boolean } = {}) {
  return async (request: Request) => {
    const body = await readJson(request);
    const filters = parseFilters((body.filters ?? {}) as Record<string, unknown>);
    // What-if parameters' values (decision 773): checked against the report's own sliders for a saved tile.
    const rawParameters = ((body.filters ?? {}) as Record<string, unknown>).parameters;
    // The organisation's calculated fields (decision 772) are read with the question, so tiles can use them.
    const { organisationId, query, fields } = await run(request, body.organisationId, "report_viewer", async (tx, { auth, membership }) => {
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
      if (options.savedOnly || !roleAtLeast(membership.role, "viewer")) throw new ForbiddenError("You can only see the dashboards shared with you.");
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
  };
}
