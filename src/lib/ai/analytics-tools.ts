import { boundedLimit, CURSOR, limitInput, pageByPosition } from "@/lib/ai/limits";
import { type AiTool, DATE, type JsonSchema, schema, type ToolContext } from "@/lib/ai/tools";
import { roleAtLeast } from "@/lib/auth/roles";
import { HUES, LEGEND_POSITIONS, PALETTES, SECOND_GROUPING, SECOND_GROUPING_REQUIRED } from "@/lib/analytics/chart-format";
import { buildTemplate, TEMPLATES } from "@/lib/analytics/templates";
import {
  checkDashboardDraft,
  createDashboard,
  suggestCommentary,
  type Dashboard,
  type DashboardReader,
  type DashboardSettings,
  dateContext,
  describeTables,
  getDashboard,
  listDashboards,
  runTile,
  type Tile,
  updateDashboard,
} from "@/lib/analytics/dashboards";
import { DATE_PRESETS, type DatePreset, isDatePreset, presetRange } from "@/lib/analytics/date-ranges";
import { hiddenFarmTables, requireAnalyticsTable } from "@/lib/analytics/farm-access";
import { columnKind, FILTER_OPS, opsFor } from "@/lib/analytics/filters";
import { GA_REPORTS } from "@/lib/analytics/google-analytics-reports";
import { fieldLabel, tableDescription, tableLabel } from "@/lib/analytics/labels";
import { TILE_HEIGHTS, TILE_WIDTHS } from "@/lib/analytics/layout";
import { measureFromSaved } from "@/lib/analytics/measure-library";
import { META_TABLES } from "@/lib/analytics/meta-reports";
import { type AnalyticsModel, loadModel } from "@/lib/analytics/model";
import { MAX_PAGES, PAGE_WIDTHS, reportPages, tilePage } from "@/lib/analytics/pages";
import { SLICER_STYLES } from "@/lib/analytics/slicers";
import { listThemes } from "@/lib/analytics/themes";
import { BUILT_IN_IDS, BUILT_IN_THEMES, CUSTOM_PREFIX } from "@/lib/charts/report-themes";
import { parameterValues } from "@/lib/analytics/parameters";
import type { DashboardFilters, QueryDates, QueryResult } from "@/lib/analytics/query";
import { QUICK_KINDS } from "@/lib/analytics/quick-calcs";
import { effectiveDates } from "@/lib/analytics/report-filters";
import { listMeasures } from "@/lib/analytics/saved-measures";
import { GSC_TABLES } from "@/lib/analytics/search-console-reports";
import { SHOPIFY_TABLES } from "@/lib/analytics/shopify-tables";
import { listShapedTables } from "@/lib/analytics/shaped-tables";
import { type LoadRun, listSources, requireAnalytics, runLoad } from "@/lib/analytics/sources";
import { BOOKS_TABLE_NAME, refreshBooks } from "@/lib/analytics/books";
import { reportLoadFacts, loadKeyOf } from "@/lib/analytics/freshness";
import { refreshGa } from "@/lib/analytics/google-analytics";
import { GA_LOAD_TABLE_NAME } from "@/lib/analytics/google-analytics-reports";
import { refreshMeta } from "@/lib/analytics/meta";
import { META_LOAD_TABLE_NAME } from "@/lib/analytics/meta-reports";
import { refreshGsc } from "@/lib/analytics/search-console";
import { GSC_LOAD_TABLE_NAME } from "@/lib/analytics/search-console-reports";
import { runShapedTableAndDependents } from "@/lib/analytics/shaped-tables";
import { refreshShopify } from "@/lib/analytics/shopify";
import { SHOPIFY_LOAD_TABLE_NAME } from "@/lib/analytics/shopify-tables";
import { TIME_PERIODS } from "@/lib/analytics/time-intelligence";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ForbiddenError, HttpError, ValidationError } from "@/lib/errors";

/*
 * The AI's Analytics tools (#591, examples AIA1-AIA9, decisions 1411-1420).
 * The AI reads the tables a person can use in Analytics (the books, Shopify,
 * Google, Meta, files and databases, and prepared tables), asks them
 * questions the way a tile does, reads reports with their figures, and makes
 * and changes reports: the same tiles, checks and save as the Analytics
 * editor, as the key's owner. Every tile it adds or changes is run first; a
 * tile that doesn't work is refused with the reason and nothing is saved.
 * Each save goes into the report's edit history marked "via AI key ...", so
 * a person can see it and put an earlier version back. It never deletes a
 * report, takes a tile off, changes sharing, sources, folders or themes.
 * Owners' and admins' AI can refresh sources through the screens' own loads
 * (decision 1419), which only fetch data again.
 * The figures are worked out from the Analytics file, outside any database
 * transaction, as the screens do (runSteps).
 */

const REPORT_VIEWER_REFUSED = "A report viewer sees only the reports shared with them, so tables and questions aren't available to this connection.";

const VISUALS = ["column", "bar", "line", "area", "combo", "pie", "donut", "kpi", "table", "pivot", "text", "waterfall", "funnel", "gauge", "bullet", "scatter", "histogram", "boxplot", "treemap", "heatmap", "calendar", "sankey", "filledmap", "pointmap", "shape", "button", "report"] as const;
const AGGREGATES = ["sum", "avg", "min", "max", "count", "count_distinct", "formula"] as const;
const GRAINS = ["day", "week", "month", "quarter", "year", "fquarter", "fyear"] as const;
const TILE_ID: JsonSchema = { type: "string", pattern: "^[a-z0-9-]{1,40}$", description: "A tile's id: lower-case letters, digits and -." };
const MAX_FIGURE_ROWS = 500;

/** What each chart needs, said once to the AI (the same rules parseTiles checks). */
const CHART_NEEDS: Record<string, string> = {
  column: "groupBy; 1-6 measures; breakdown makes one small chart each",
  bar: "groupBy; 1-6 measures; breakdown makes one small chart each",
  line: "groupBy (usually a date with a grain); 1-6 measures; breakdown makes one small chart each",
  area: "groupBy (usually a date); 1-6 measures",
  combo: "groupBy; 2+ measures (columns and a line)",
  pie: "groupBy; exactly 1 measure",
  donut: "groupBy; exactly 1 measure",
  kpi: "no groupBy; 1 measure (a second is shown beside it); compare previous_period or previous_year with a dateField; sparkline: true for a trend",
  table: "groupBy optional; up to 6 measures; format.table.totals: true for a totals row",
  pivot: "query.pivot { rows: [1-5 fields], column }, no groupBy; sum, count, avg, min or max only",
  text: "text (notes); textFormat \"rich\" allows {Value} with a query of one total each",
  waterfall: "groupBy; exactly 1 measure",
  funnel: "groupBy; exactly 1 measure",
  gauge: "no groupBy; a value and optionally a target (1-2 measures); format.gauge for its range",
  bullet: "groupBy optional; a value and optionally a target (1-2 measures)",
  scatter: "groupBy; 2 measures (across, up), a third sizes bubbles",
  histogram: "groupBy (the items to bin); exactly 1 measure",
  boxplot: "groupBy; exactly 1 measure; breakdown: what each box is made of",
  treemap: "groupBy; exactly 1 measure; breakdown optional",
  heatmap: "groupBy across and breakdown down the side; exactly 1 measure",
  calendar: "groupBy a date with grain day; exactly 1 measure",
  sankey: "groupBy (from) and breakdown (to); exactly 1 measure",
  filledmap: "groupBy NZ regions or districts by name; exactly 1 measure",
  pointmap: "groupBy; latitude and longitude measures, a third sizes points",
  shape: "shape: { kind: rectangle, rounded, ellipse or line }",
  button: "button: { label, action } (reset filters, or a page or bookmark of the report)",
  report: "report: { id } of a custom report from list_custom_reports (an accounting report in statement style; a published one is the only kind report viewers can see); no query",
};

/** How to build a tile, once on the first page of list_analytics_tables. */
function buildingGuide() {
  return {
    charts: CHART_NEEDS,
    secondGrouping: Object.keys(SECOND_GROUPING),
    secondGroupingRequired: SECOND_GROUPING_REQUIRED,
    aggregates: "sum and avg need a number column; count needs no field; count_distinct; formula: e.g. \"[Sales] - [Costs]\" where the names are the tile's other measures' labels or its inputs.",
    grains: [...GRAINS],
    filterOps: { text: opsFor("VARCHAR").map((op) => op.value), number: opsFor("DECIMAL(18,2)").map((op) => op.value), date: opsFor("DATE").map((op) => op.value), boolean: opsFor("BOOLEAN").map((op) => op.value) },
    filterValues: "in and not_in take a list; between takes [from, to]; last_days and last_months a whole number; this_financial_year, last_financial_year, blank and not_blank nothing; the rest one value as text. Filters after the first can have join: \"or\".",
    datePresets: DATE_PRESETS.map((preset) => preset.value),
    dates: "A report's dates apply to each tile's dateField (a tile grouped by a date uses that date). A tile's own dates ({ preset } or { from, to }) replace the report's.",
    quickCalcs: QUICK_KINDS.map((kind) => kind.value),
    periods: TIME_PERIODS.map((period) => period.value),
    widths: [...TILE_WIDTHS],
    heights: [...TILE_HEIGHTS],
    format:
      "Optional, but a good report sets it: each value's number format (series[n].number: percent, currency, decimals, compact), a subtitle on each chart (card.subtitle), comparisons on key figures (kpi), colours and rules. " +
      "analytics_format_guide has every key with examples, how to lay a report out, and the ready-made templates.",
    books:
      "The books' ledger (tohyee_ledger_lines) stores amount as debit less credit, so income and liabilities are negative: use the table's savedValues (e.g. revenue) or negate: true with a where on account_type.",
  };
}

/** Where a table's data comes from, in words. */
function tableSource(name: string, sources: Map<string, string>, shaped: Map<string, string>): string {
  if (SHOPIFY_TABLES.some((table) => table.table === name)) return "Shopify";
  if (GA_REPORTS.some((report) => report.table === name)) return "Google Analytics";
  if (GSC_TABLES.some((table) => table.table === name)) return "Google Search Console";
  if (META_TABLES.some((table) => table.table === name)) return "Meta (Facebook and Instagram)";
  if (name.startsWith("tohyee_farm_")) return "Tohyee farm records";
  if (name.startsWith("tohyee_crm_")) return "Tohyee CRM";
  if (name.startsWith("tohyee_")) return "Tohyee books";
  if (sources.has(name)) return sources.get(name)!;
  if (shaped.has(name)) return shaped.get(name)!;
  return "Loaded table";
}

/** The connection's person, as Analytics sees them (report viewers only see what's shared, decision 360). */
function readerOf(tx: OrgTx, context: ToolContext): DashboardReader {
  return { userId: tx.actor.userId, reportViewer: context.role === "report_viewer" };
}

function requireTablesAllowed(context: ToolContext): void {
  if (!roleAtLeast(context.role, "viewer")) throw new ForbiddenError(REPORT_VIEWER_REFUSED);
}

function requireEditor(context: ToolContext): void {
  if (!roleAtLeast(context.role, "bookkeeper")) throw new ForbiddenError("Making and changing reports needs the bookkeeper role or higher.");
}

/** The labels for the coded values that are in the answer (decision 1499), so it stays small. */
function usedLabels(labels: Record<string, string> | undefined, values: Array<string | null | undefined>): { valueLabels?: Record<string, string> } {
  if (!labels) return {};
  const used = Object.fromEntries(values.flatMap((value) => (typeof value === "string" && Object.prototype.hasOwnProperty.call(labels, value) ? [[value, labels[value]]] : [])));
  return Object.keys(used).length ? { valueLabels: used } : {};
}

/** A tile's or question's answer, cut to `rows` rows so one answer stays small. */
function figures(result: QueryResult, rows: number) {
  if (result.pivot) {
    const pivot = result.pivot;
    return {
      pivot: {
        rowFields: pivot.rowFields.map((field) => field.label),
        ...(pivot.rowFields.some((field) => field.valueLabels) ? { rowFieldLabels: pivot.rowFields.map((field, index) => usedLabels(field.valueLabels, pivot.rows.map((row) => row.dimensions[index])).valueLabels ?? null) } : {}),
        columns: pivot.columns.map((column) => ({ key: column.key, label: column.label, measure: column.measure.label, total: column.total })),
        rows: pivot.rows.slice(0, rows).map((row) => ({ kind: row.kind, dimensions: row.dimensions, cells: row.cells })),
        rowCount: pivot.rows.length,
      },
      ...(result.notes?.length ? { notes: result.notes } : {}),
    };
  }
  const shown = result.rows.slice(0, rows);
  return {
    // A coded group's values in words (decision 1499): the rows keep the code, which is what filters use.
    columns: result.columns.map((column) => ({ key: column.key, label: column.label, format: column.format, role: column.role, ...usedLabels(column.valueLabels, shown.map((row) => row[column.key])) })),
    rows: shown,
    rowCount: result.rows.length,
    truncated: result.truncated || result.rows.length > rows,
    ...(result.totals ? { totals: result.totals } : {}),
    ...(result.trend ? { trend: result.trend } : {}),
    ...(result.notes?.length ? { notes: result.notes } : {}),
  };
}

function problem(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return "It couldn't be worked out from the data as it is now.";
}

/** What a tile is asked with on its report: the report's dates (or its own), its page's filters and the parameters' starting values. */
function tileFilters(tile: Tile, settings: DashboardSettings, dates: QueryDates): DashboardFilters {
  const report = { from: settings.from, to: settings.to, values: {} };
  const own = effectiveDates(tile.dates, report, dates.today, dates.yearEndMonth);
  const page = reportPages(settings.pages).find((entry) => entry.id === tilePage(tile, settings.pages));
  return { ...report, ...own, dates, view: (page?.filters ?? []).map((entry) => entry.filter), parameters: parameterValues(settings.parameters, undefined) };
}

type Run = { tile: Tile; result?: QueryResult; error?: string };

/** Runs each tile with a question (outside any transaction). */
async function runTiles(organisationId: string, tiles: Tile[], settings: DashboardSettings, dates: QueryDates, model: AnalyticsModel, hidden: { has: (table: string) => boolean } | null): Promise<Run[]> {
  const runs: Run[] = [];
  for (const tile of tiles) {
    if (!tile.query) {
      runs.push({ tile });
      continue;
    }
    if (hidden?.has(tile.query.table)) {
      runs.push({ tile, error: "This tile reads a farm table, which is for members who see every farm." });
      continue;
    }
    try {
      const totals = tile.visual === "table" && tile.format?.table?.totals === true;
      runs.push({ tile, result: await runTile(organisationId, tile.query, tileFilters(tile, settings, dates), { totals, model }) });
    } catch (error) {
      runs.push({ tile, error: problem(error) });
    }
  }
  return runs;
}

function datesInput(input: unknown): Record<string, unknown> | null {
  if (input === undefined || input === null) return null;
  const raw = (typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (raw.preset !== undefined && raw.preset !== null) {
    if (!isDatePreset(raw.preset)) throw new ValidationError(`dates.preset is one of ${DATE_PRESETS.map((preset) => preset.value).join(", ")}.`);
    return { preset: raw.preset, from: null, to: null };
  }
  return { preset: null, from: raw.from ?? null, to: raw.to ?? null };
}

function dashboardSummary(dashboard: Dashboard) {
  return {
    id: dashboard.id,
    name: dashboard.name,
    description: dashboard.description,
    version: dashboard.version,
    tiles: dashboard.tiles.length,
    pages: reportPages(dashboard.settings.pages).map((page) => ({ id: page.id, name: page.name })),
    dates: { preset: dashboard.settings.preset, from: dashboard.settings.from, to: dashboard.settings.to },
    createdByEmail: dashboard.createdByEmail,
    createdAt: dashboard.createdAt,
    updatedByEmail: dashboard.updatedByEmail,
    updatedAt: dashboard.updatedAt,
    link: `/analytics/dashboards/${dashboard.id}`,
  };
}

/** A tile as the AI reads it back: as saved, without the parts it can't set. */
function tileOut(tile: Tile) {
  return {
    id: tile.id,
    title: tile.title,
    visual: tile.visual,
    width: tile.width,
    height: tile.height ?? "medium",
    ...(tile.page ? { page: tile.page } : {}),
    query: tile.query,
    ...(tile.text ? { text: tile.text } : {}),
    ...(tile.textFormat ? { textFormat: tile.textFormat } : {}),
    ...(tile.format ? { format: tile.format } : {}),
    ...(tile.dates ? { dates: tile.dates } : {}),
    ...(tile.shape ? { shape: tile.shape } : {}),
    ...(tile.button ? { button: tile.button } : {}),
    ...(tile.visual === "image" ? { note: "An image: people add and change images in Tohyee." } : {}),
  };
}

/**
 * Checks and runs a report's tiles before it's saved (AIA4): the editor's
 * checks first, then each new or changed tile is run on the data. The
 * first that fails is refused, naming the tile and what to fix.
 */
async function checkAndRun(
  run: OrgRunner,
  draft: { settings: unknown; tiles: unknown[] },
  isNew: (tile: { id?: unknown }) => boolean,
): Promise<{ settings: DashboardSettings; tiles: Tile[]; runs: Run[] }> {
  const checked = await run(async (tx) => {
    // Farm tables are for members who see every farm (decision 744): not through the AI either, checked before anything else.
    for (const [index, entry] of draft.tiles.entries()) {
      const tile = (entry ?? {}) as { id?: unknown; title?: unknown; visual?: unknown; query?: { table?: unknown } | null };
      if (!isNew(tile)) continue;
      const title = typeof tile.title === "string" && tile.title.trim() ? tile.title.trim() : `Tile ${index + 1}`;
      if (tile.visual === "image") throw new ValidationError(`${title}: images are uploaded to a report in Tohyee, so they can't be added here. Nothing was saved.`);
      try {
        await requireAnalyticsTable(tx, tile.query?.table);
      } catch (error) {
        throw new ValidationError(`${title}: ${problem(error)} Nothing was saved.`);
      }
    }
    let parsed: { settings: DashboardSettings; tiles: Tile[] };
    try {
      parsed = await checkDashboardDraft(tx, draft);
    } catch (error) {
      if (error instanceof HttpError) throw new ValidationError(`${error.message} Nothing was saved.`);
      throw error;
    }
    return { ...parsed, organisationId: tx.organisationId, dates: await dateContext(tx), model: await loadModel(tx) };
  });
  const runs = await runTiles(checked.organisationId, checked.tiles.filter(isNew), checked.settings, { today: checked.dates.today, yearEndMonth: checked.dates.yearEndMonth }, checked.model, null);
  const broken = runs.find((entry) => entry.error);
  if (broken) {
    const position = checked.tiles.indexOf(broken.tile) + 1;
    throw new ValidationError(`Tile ${position} (${broken.tile.title}) doesn't work: ${broken.error} Fix it and send the report again. Nothing was saved.`);
  }
  return { settings: checked.settings, tiles: checked.tiles, runs };
}

/** What the AI is told after a save: the report, each checked tile's first rows, and anything worth a second look. */
function saved(dashboard: Dashboard, runs: Run[]) {
  const warnings = runs.filter((entry) => entry.result && (entry.result.pivot ? entry.result.pivot.rows.length === 0 : entry.result.rows.length === 0)).map((entry) => `${entry.tile.title}: no rows in these dates or filters.`);
  return {
    dashboard: dashboardSummary(dashboard),
    checkedTiles: runs.map((entry) => ({ id: entry.tile.id, title: entry.tile.title, ...(entry.result ? { preview: figures(entry.result, 5) } : {}) })),
    ...(warnings.length ? { warnings } : {}),
    note: "Saved. People see it under Analytics › Reports. The change is in the report's History, marked as made through the AI, where a person can put an earlier version back.",
  };
}

// --- Input schemas -----------------------------------------------------------

const FIELD = (what: string): JsonSchema => ({ type: "string", description: what });
const GROUP: JsonSchema = {
  type: "object",
  description: "A column to group by; a date column takes a grain (default month).",
  properties: { field: FIELD("A column of the table."), grain: { type: "string", enum: [...GRAINS], description: "fquarter and fyear follow the organisation's balance date." } },
  required: ["field"],
};
const FILTER: JsonSchema = {
  type: "object",
  properties: {
    field: FIELD("A column of the table."),
    op: { type: "string", enum: [...FILTER_OPS] },
    value: { description: "Text, a list (in, not_in), [from, to] (between) or a whole number (last_days, last_months); leave out for tests that need none.", oneOf: [{ type: "string" }, { type: "number" }, { type: "array", items: { type: "string" } }] },
    join: { type: "string", enum: ["or"], description: "Join this filter to the one before with or (default and)." },
  },
  required: ["field", "op"],
};
const MEASURE: JsonSchema = {
  type: "object",
  description: "A value to show.",
  properties: {
    label: { type: "string", maxLength: 80, description: "Its name on the chart, e.g. Sales." },
    aggregate: { type: "string", enum: [...AGGREGATES] },
    field: FIELD("The column to add up (not needed for count or formula)."),
    times: FIELD("Multiplies field row by row first, e.g. quantity times unit_price."),
    negate: { type: "boolean", description: "Show it the other way round, e.g. credits such as sales as positive." },
    where: { type: "array", maxItems: 10, items: FILTER, description: "Only rows like these count towards this value." },
    asAt: { type: "boolean", description: "A balance: everything up to the report's To date." },
    compare: { type: "string", enum: ["previous_year", "previous_period"], description: "Also the same value a year before (grouped by a date), or the period before (one total)." },
    formula: { type: "string", maxLength: 500, description: "With aggregate formula: e.g. [Sales] - [Costs]." },
    inputs: { type: "array", maxItems: 20, items: { type: "object", description: "A named value the formula uses: name, aggregate, field and the rest as for a measure." } },
    quick: { type: "object", properties: { kind: { type: "string", enum: QUICK_KINDS.map((kind) => kind.value) }, periods: { type: "integer", minimum: 2, maximum: 12 } }, required: ["kind"] },
    period: { type: "string", enum: TIME_PERIODS.map((period) => period.value), description: "The value over the financial year, quarter or month to date, or the last 12 months." },
    currencyField: FIELD("The column naming each row's currency."),
  },
  required: ["aggregate"],
};
const QUERY: JsonSchema = {
  type: "object",
  description: "One question of one table, as a tile asks it. Column names are exactly as list_analytics_tables gives them.",
  properties: {
    table: FIELD("A table from list_analytics_tables."),
    groupBy: GROUP,
    breakdown: { ...GROUP, description: "A second grouping (see the guide in list_analytics_tables)." },
    pivot: {
      type: "object",
      description: "For a pivot tile only.",
      properties: { rows: { type: "array", minItems: 1, maxItems: 5, items: GROUP }, column: GROUP, subColumns: { type: "array", maxItems: 2, items: GROUP } },
      required: ["rows"],
    },
    measures: { type: "array", minItems: 1, maxItems: 6, items: MEASURE },
    filters: { type: "array", maxItems: 20, items: FILTER },
    dateField: FIELD("The date column the report's dates apply to (a tile grouped by a date uses that date)."),
    sort: { type: "object", properties: { by: { type: "string", enum: ["category", "value"] }, direction: { type: "string", enum: ["asc", "desc"] } } },
    limit: { type: "integer", minimum: 1, maximum: 5000, description: "Top N groups after sorting." },
    sparkline: { type: "boolean", description: "A key figure's trend by month (needs a dateField and no grouping)." },
  },
  required: ["table", "measures"],
};
const HEX: JsonSchema = { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "A colour as #rrggbb." };
const NUMBER_FORMAT: JsonSchema = {
  type: "object",
  description: "How a number shows. A ratio such as a margin needs style percent, or it shows as 0.35.",
  properties: {
    style: { type: "string", enum: ["auto", "currency", "percent", "plain"] },
    decimals: { type: "integer", minimum: 0, maximum: 4 },
    compact: { type: "boolean", description: "12.3K, 4.5M." },
    thousands: { type: "boolean" },
    prefix: { type: "string", maxLength: 20 },
    suffix: { type: "string", maxLength: 20 },
  },
};
const TEXT_STYLE: Record<string, JsonSchema> = {
  size: { type: "integer", minimum: 8, maximum: 32 },
  bold: { type: "boolean" },
  italic: { type: "boolean" },
  color: HEX,
  align: { type: "string", enum: ["left", "center", "right"] },
};
const AXIS: JsonSchema = {
  type: "object",
  properties: { title: { type: "string", maxLength: 60 }, show: { type: "boolean" }, gridlines: { type: "boolean" }, zero: { type: "boolean", description: "Start at zero." }, log: { type: "boolean" }, min: { type: "string" }, max: { type: "string" }, number: NUMBER_FORMAT, rotate: { type: "integer", minimum: -90, maximum: 90 }, reverse: { type: "boolean" } },
};
const COLOUR_RULE: JsonSchema = {
  type: "object",
  properties: { op: { type: "string", enum: [">=", ">", "<=", "<", "="] }, value: { type: "string", description: "A number as text." }, color: HEX },
  required: ["op", "value", "color"],
};
/**
 * A tile's format as the AI is told it (#689): the keys parseChartFormat
 * takes that matter for how a report reads. Anything else the editor has is
 * still accepted. tests/unit/ai-analytics-format.test.ts checks every key
 * here is one parseChartFormat keeps.
 */
export const FORMAT_SCHEMA: JsonSchema = {
  type: "object",
  description: "How the tile looks. analytics_format_guide explains each key with examples.",
  properties: {
    palette: { type: "string", enum: Object.keys(PALETTES) },
    series: {
      type: "array",
      maxItems: 12,
      description: "One entry for each measure, in order: its number format, colour, and (combo) whether it's a bar or a line and which axis.",
      items: {
        type: "object",
        properties: {
          number: NUMBER_FORMAT,
          as: { type: "string", enum: ["bar", "line"] },
          axis: { type: "string", enum: ["left", "right"] },
          color: { type: "string", enum: [...HUES] },
          hex: HEX,
          lineWidth: { type: "integer", minimum: 1, maximum: 6 },
          lineStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
          markers: { type: "boolean" },
          trend: { type: "boolean", description: "A straight trend line." },
        },
      },
    },
    colorByCategory: { type: "boolean", description: "One measure: a colour for each bar." },
    negativeRed: { type: "boolean" },
    labels: {
      type: "object",
      properties: { show: { type: "boolean" }, position: { type: "string", enum: ["auto", "inside", "outside"] }, size: { type: "integer", minimum: 8, maximum: 24 }, number: NUMBER_FORMAT, density: { type: "string", enum: ["all", "auto", "ends"] } },
    },
    legend: { type: "object", properties: { show: { type: "string", enum: ["auto", "show", "hide"] }, position: { type: "string", enum: [...LEGEND_POSITIONS] }, title: { type: "string", maxLength: 60 } } },
    categoryAxis: { type: "object", properties: { title: { type: "string", maxLength: 60 }, show: { type: "boolean" }, rotate: { type: "integer", minimum: -90, maximum: 90 }, interval: { type: "integer", minimum: 0, maximum: 50 } } },
    valueAxis: AXIS,
    rightAxis: AXIS,
    stack: { type: "string", enum: ["none", "stacked", "percent"] },
    smooth: { type: "boolean" },
    markers: { type: "boolean" },
    zoom: { type: "boolean", description: "A slider to zoom a long time series." },
    donutTotal: { type: "boolean", description: "The total in the middle of a donut." },
    bars: { type: "object", properties: { thickness: { type: "integer", minimum: 4, maximum: 80 }, gap: { type: "integer", minimum: 0, maximum: 90 }, rounded: { type: "boolean" } } },
    referenceLines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["constant", "target", "average", "median", "min", "max", "percentile", "band"] },
          value: { type: "string" },
          to: { type: "string", description: "A band's upper value." },
          percentile: { type: "integer", minimum: 1, maximum: 99 },
          label: { type: "string", maxLength: 60 },
          color: HEX,
          style: { type: "string", enum: ["solid", "dashed", "dotted"] },
        },
      },
    },
    card: {
      type: "object",
      description: "The tile's card: a subtitle says what to look for.",
      properties: {
        subtitle: { type: "string", maxLength: 200 },
        showTitle: { type: "boolean" },
        background: { type: "string", enum: ["plain", "tinted", "none"] },
        border: { type: "boolean" },
        shadow: { type: "string", enum: ["none", "soft", "strong"] },
        radius: { type: "integer", minimum: 0, maximum: 24 },
        fill: HEX,
        title: { type: "object", properties: TEXT_STYLE },
      },
    },
    kpi: {
      type: "object",
      description: "A key figure.",
      properties: {
        target: { type: "string", description: "A number as text: the change is shown against it." },
        change: { type: "string", enum: ["both", "amount", "percent"] },
        downIsGood: { type: "boolean", description: "For costs: a fall is green." },
        size: { type: "string", enum: ["s", "m", "l", "xl"] },
        align: { type: "string", enum: ["left", "center", "right"] },
        label: { type: "string", enum: ["none", "above", "below"] },
        colorBy: { type: "string", enum: ["none", "rules", "change"] },
        rules: { type: "array", maxItems: 6, items: COLOUR_RULE },
        icon: { type: "string", enum: ["none", "arrow", "dot"] },
        sparkline: { type: "string", enum: ["line", "area", "column"] },
        multi: { type: "boolean", description: "Several numbers in one card (one for each measure)." },
      },
    },
    chartRules: { type: "array", maxItems: 6, description: "Colour bars by their value, e.g. red under a target.", items: { ...COLOUR_RULE, properties: { ...(COLOUR_RULE.properties as Record<string, JsonSchema>), series: { type: "integer", minimum: 0, maximum: 11 } } } },
    dataBars: { type: "array", description: "Table and pivot: a bar in the cells of these measures (value is the measure's position, from 0).", items: { type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 11 }, color: HEX }, required: ["value"] } },
    table: {
      type: "object",
      properties: { totals: { type: "boolean" }, totalsStyle: { type: "string", enum: ["bold", "shaded"] }, banded: { type: "boolean" }, gridlines: { type: "string", enum: ["all", "rows", "none"] }, fontSize: { type: "integer", minimum: 10, maximum: 18 }, wrap: { type: "boolean" } },
    },
    waterfall: { type: "object", properties: { total: { type: "boolean" }, totalLabel: { type: "string", maxLength: 40 }, connectors: { type: "boolean" } } },
    gauge: { type: "object", properties: { min: { type: "string" }, max: { type: "string" }, target: { type: "string" } } },
    histogram: { type: "object", properties: { bins: { type: "integer", minimum: 2, maximum: 50 } } },
    smallMultiples: { type: "object", properties: { max: { type: "integer", minimum: 2, maximum: 12 } } },
    map: { type: "object", properties: { areas: { type: "string", enum: ["regions", "districts"] } } },
  },
};

/** Worked formats the AI can copy (each is checked by parseChartFormat in the tests). */
export const FORMAT_EXAMPLES: Record<string, { why: string; visual: string; format: Record<string, unknown> }> = {
  percentKeyFigure: {
    why: "A margin or rate: without this a ratio shows as 0.35, not 35.0%.",
    visual: "kpi",
    format: { series: [{ number: { style: "percent", decimals: 1 } }], kpi: { change: "percent", icon: "arrow" }, card: { subtitle: "Gross profit as a share of sales" } },
  },
  moneyKeyFigure: {
    why: "A headline amount: whole dollars, with the change against the period before.",
    visual: "kpi",
    format: { series: [{ number: { style: "currency", decimals: 0 } }], kpi: { change: "both", icon: "arrow", sparkline: "area" } },
  },
  costKeyFigure: {
    why: "A cost: a fall is good news, so it shows green.",
    visual: "kpi",
    format: { series: [{ number: { style: "currency", decimals: 0 } }], kpi: { change: "percent", downIsGood: true, icon: "arrow" } },
  },
  salesAndMargin: {
    why: "Two measures of different sizes: sales as columns, margin % as a line on the right.",
    visual: "combo",
    format: {
      series: [{ as: "bar", number: { style: "currency", decimals: 0, compact: true } }, { as: "line", axis: "right", number: { style: "percent", decimals: 0 } }],
      rightAxis: { title: "Gross margin" },
      card: { subtitle: "Sales by month, with gross margin on the right" },
    },
  },
  trendWithTarget: {
    why: "A line against a threshold or target.",
    visual: "line",
    format: { smooth: true, series: [{ number: { style: "currency", decimals: 0, compact: true } }], referenceLines: [{ kind: "constant", value: "60000", label: "Target", style: "dashed" }], card: { subtitle: "Where the line crosses the target" } },
  },
  rankedBars: {
    why: "Top N by value: one colour, the value on each bar, sorted largest first (sort by value desc, limit 10).",
    visual: "bar",
    format: { labels: { show: true, number: { style: "currency", decimals: 0, compact: true } }, bars: { rounded: true }, legend: { show: "hide" } },
  },
  shareDonut: {
    why: "A split of one total into at most 6 parts; more parts read better as ranked bars.",
    visual: "donut",
    format: { donutTotal: true, labels: { show: true, number: { style: "percent", decimals: 0 } } },
  },
  detailTable: {
    why: "The rows behind the charts: a totals row, bands, and a bar in the first measure's cells.",
    visual: "table",
    format: { table: { totals: true, banded: true }, dataBars: [{ value: 0 }], series: [{ number: { style: "currency", decimals: 0 } }] },
  },
  barsBelowTarget: {
    why: "Columns turn red when under a level.",
    visual: "column",
    format: { chartRules: [{ op: "<", value: "0", color: "#b32228" }], series: [{ number: { style: "currency", decimals: 0, compact: true } }] },
  },
};

/** How to lay a report out so it reads well without anyone tidying it (#689). */
const LAYOUT_ADVICE: string[] = [
  "Start with a row of 3 or 4 key figures (width quarter or third, height small): the numbers a person checks first. Give each a dateField and compare previous_period or previous_year, and sparkline: true.",
  "Then one main chart, full width: the trend over time that explains the key figures (line, area or combo by month).",
  "Then breakdowns in pairs (width half): ranked bars for top customers, products or costs; a donut only for 6 parts or fewer.",
  "End with a table of the detail (width full) with a totals row.",
  "Give every chart a card.subtitle saying what to look for, in plain words.",
  "Set each value's number format: currency with 0 decimals for headline money, percent for ratios, compact on axes and bar labels.",
  "Name measures the way people say them (Sales, Gross margin %), never a column name.",
  "Keep a page to about 8 tiles. A long report reads better as a second report than as a wall of tiles.",
  "Use the report's dates (a preset such as this_financial_year or last_12_months) so it moves with today; give a tile its own dates only when it needs a different window.",
  "After saving, read it back with get_analytics_dashboard and fix anything that looks wrong in the figures (blank tiles, a ratio with no percent format).",
];

const TILE_DATES: JsonSchema = {
  type: "object",
  description: "The tile's own dates, in place of the report's: { preset } or { from, to }.",
  properties: { preset: { type: "string", enum: DATE_PRESETS.map((preset) => preset.value) }, from: DATE, to: DATE },
};
const TILE_PROPERTIES: Record<string, JsonSchema> = {
  title: { type: "string", maxLength: 100 },
  visual: { type: "string", enum: [...VISUALS], description: "How it's shown; what each needs is in list_analytics_tables' guide." },
  width: { type: "string", enum: [...TILE_WIDTHS], description: "Default half." },
  height: { type: "string", enum: [...TILE_HEIGHTS], description: "Default medium." },
  query: QUERY,
  text: { type: "string", maxLength: 20000, description: "A text tile's notes." },
  textFormat: { type: "string", enum: ["rich"] },
  format: FORMAT_SCHEMA,
  dates: TILE_DATES,
  page: { type: "string", description: "The report page it's on (get_analytics_dashboard lists them); default the first." },
  shape: { type: "object" },
  button: { type: "object" },
  report: { type: "object", description: "For visual report: the custom report to show.", properties: { id: { type: "string", description: "From list_custom_reports." } }, required: ["id"] },
};
const TILE: JsonSchema = {
  type: "object",
  properties: { id: { ...TILE_ID, description: "Optional: your own id for the tile, to refer to it later." }, ...TILE_PROPERTIES },
  required: ["title", "visual"],
};
/** A report's look and controls the AI can set (#690), each replacing what the report has. */
const REPORT_THEME: JsonSchema = { type: "string", description: 'A theme from analytics_format_guide: a built-in id (tohyee, harbour, kowhai, bush, bright, contrast) or a saved one as "custom:<id>". "tohyee" is the default look.' };
const REPORT_SLICERS: JsonSchema = {
  type: "array",
  maxItems: 6,
  description: "The report's slicers (the filters a reader can change), replacing the ones it has. Each filters every tile whose table has the column.",
  items: {
    type: "object",
    properties: {
      table: FIELD("A table from list_analytics_tables."),
      field: FIELD("The column readers choose values of."),
      label: { type: "string", maxLength: 60, description: "Default the column's name." },
      style: { type: "string", enum: [...SLICER_STYLES], description: "Text: list, dropdown, single or search. Numbers: range. Dates: dates or relative. Default list." },
      pages: { type: "array", items: { type: "string" }, description: "Only on these pages (page ids); default every page." },
    },
    required: ["table", "field"],
  },
};
const REPORT_PAGES: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_PAGES,
  description: "The report's pages in order, replacing the ones it has (a page left out is removed, and its tiles move to the first page). A page keeps its own filters and background picture when its id stays the same. Put a tile on a page with the tile's page.",
  items: {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^[a-z0-9-]{1,40}$", description: "Your own short id, e.g. sales. Keep an existing page's id to keep the page." },
      name: { type: "string", maxLength: 40 },
      width: { type: "string", enum: [...PAGE_WIDTHS] },
      background: { type: "string", description: '"tinted", or a colour as #rrggbb.' },
      hidden: { type: "boolean", description: "Not in the page tabs: reached by a button or drill-through." },
    },
    required: ["id", "name"],
  },
};

/** The settings a create or update asks for (#690), on top of the report's own; null when nothing is asked. */
function settingsAsked(current: DashboardSettings | null, args: Record<string, unknown>): Record<string, unknown> | null {
  const dates = datesInput(args.dates);
  if (!dates && args.theme === undefined && args.slicers === undefined && args.pages === undefined) return null;
  const next: Record<string, unknown> = { ...(current ?? { slicers: [] }), ...(dates ?? {}) };
  if (args.theme !== undefined) next.theme = args.theme === null || args.theme === "tohyee" ? undefined : args.theme;
  if (args.slicers !== undefined) next.slicers = args.slicers;
  if (args.pages !== undefined) {
    if (!Array.isArray(args.pages)) throw new ValidationError("pages is a list of pages. Nothing was saved.");
    // A page that stays (the same id) keeps what only people set on it: its filters, picture and drill-through.
    const before = new Map((current?.pages ?? []).map((page) => [page.id, page]));
    next.pages = args.pages.map((entry) => {
      const asked = (entry ?? {}) as Record<string, unknown>;
      const kept = typeof asked.id === "string" ? before.get(asked.id) : undefined;
      return { ...(kept ? { filters: kept.filters, picture: kept.picture, drillThrough: kept.drillThrough } : {}), ...asked };
    });
  }
  return next;
}

const REPORT_DATES: JsonSchema = {
  type: "object",
  description: "The report's dates: { preset } (they move with today) or { from, to }. Default all time.",
  properties: { preset: { type: "string", enum: DATE_PRESETS.map((preset) => preset.value) }, from: DATE, to: DATE },
};

const BUILT_IN_NAMES: Record<string, string> = { books: "Books and CRM", shopify: "Shopify", ga: "Google Analytics", gsc: "Google Search Console", meta: "Meta" };

// --- The tools ---------------------------------------------------------------

/** A tool that works in steps (figures are worked out between transactions); `run` does it all in one, for callers with a transaction. */
function stepped(tool: Omit<AiTool, "run" | "runSteps"> & { runSteps: NonNullable<AiTool["runSteps"]> }): AiTool {
  return { ...tool, run: (tx, args, context) => tool.runSteps((work) => work(tx), args, context) };
}

export const ANALYTICS_READ_TOOLS: AiTool[] = [
  stepped({
    name: "list_analytics_tables",
    title: "List Analytics tables and their fields",
    description:
      "The tables this person can use in Analytics (the books, CRM, Shopify, Google Analytics, Search Console, Meta, loaded files, databases and prepared tables), where each comes from, its fields with types, and its saved values. The first page also has a guide to building tiles. Read this before asking questions or laying out a report.",
    level: "read",
    inputSchema: schema({
      table: FIELD("Only this table."),
      search: FIELD("Only tables whose name, label or source has these words."),
      limit: limitInput(20, 100),
      cursor: CURSOR,
    }),
    async runSteps(run, args, context) {
      requireTablesAllowed(context);
      const facts = await run(async (tx) => {
        await requireAnalytics(tx);
        const sources = new Map((await listSources(tx)).map((source) => [source.tableName, `${source.database ? "Database" : "File"}: ${source.name}`] as const));
        const shaped = new Map((await listShapedTables(tx)).map((shape) => [shape.tableName, `Prepared from ${tableLabel(shape.baseTable)}: ${shape.name}`] as const));
        const measures = await listMeasures(tx);
        return { organisationId: tx.organisationId, hidden: await hiddenFarmTables(tx), model: await loadModel(tx), sources, shaped, measures };
      });
      const words = typeof args.search === "string" ? args.search.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const tables = (await describeTables(facts.organisationId, facts.model))
        // A member who sees only some farms doesn't get the farm tables (decision 744).
        .filter((table) => !facts.hidden?.has(table.name))
        .filter((table) => typeof args.table !== "string" || !args.table || table.name === args.table)
        .map((table) => ({ ...table, source: tableSource(table.name, facts.sources, facts.shaped) }))
        .filter((table) => words.every((word) => `${table.name} ${tableLabel(table.name)} ${table.source}`.toLowerCase().includes(word)));
      const page = pageByPosition(tables, args.cursor, boundedLimit(args.limit, 20, 100));
      return {
        tables: page.rows.map((table) => {
          const saved = facts.measures.filter((measure) => measure.table === table.name);
          return {
            name: table.name,
            label: tableLabel(table.name),
            source: table.source,
            ...(tableDescription(table.name) ? { description: tableDescription(table.name) } : {}),
            fields: table.columns.map((column) => ({
              name: column.name,
              label: fieldLabel(column.name),
              type: column.type,
              kind: columnKind(column.type),
              ...("calculated" in column && column.calculated ? { calculated: true } : {}),
              ...("related" in column && column.related ? { related: column.related } : {}),
              ...(column.settings?.description ? { description: column.settings.description } : {}),
            })),
            ...(saved.length ? { savedValues: saved.map((measure) => ({ name: measure.name, ...(measure.description ? { description: measure.description } : {}), measure: measureFromSaved(measure) })) } : {}),
          };
        }),
        more: page.more,
        nextCursor: page.nextCursor,
        ...(args.cursor ? {} : { guide: buildingGuide() }),
        ...(tables.length === 0 && !args.table && !args.search ? { note: "Nothing is loaded into Analytics yet. A person connects sources and loads them in Analytics › Data sources." } : {}),
      };
    },
  }),
  stepped({
    name: "run_analytics_query",
    title: "Ask an Analytics table a question",
    description:
      "Works out one question the way a tile does (group by, measures, filters, dates), saving nothing, so you can explore the data before laying out a report. Numbers come back as exact text. A pivot question answers as a pivot.",
    level: "read",
    inputSchema: schema(
      {
        query: QUERY,
        dates: REPORT_DATES,
        rows: { type: "integer", minimum: 1, maximum: MAX_FIGURE_ROWS, description: "At most this many rows back (default 100)." },
      },
      ["query"],
    ),
    async runSteps(run, args, context) {
      requireTablesAllowed(context);
      const facts = await run(async (tx) => {
        await requireAnalytics(tx);
        await requireAnalyticsTable(tx, (args.query as { table?: unknown } | undefined)?.table);
        return { organisationId: tx.organisationId, dates: await dateContext(tx), model: await loadModel(tx) };
      });
      const dates = datesInput(args.dates);
      const range = dates?.preset ? presetRange(dates.preset as DatePreset, facts.dates.today, facts.dates.yearEndMonth) : { from: (dates?.from as string | null) ?? null, to: (dates?.to as string | null) ?? null };
      const result = await runTile(facts.organisationId, args.query, { ...range, dates: { today: facts.dates.today, yearEndMonth: facts.dates.yearEndMonth } }, { model: facts.model });
      return { dates: range, ...figures(result, boundedLimit(args.rows, 100, MAX_FIGURE_ROWS)) };
    },
  }),
  {
    name: "list_analytics_dashboards",
    title: "List Analytics reports",
    description: "The Analytics reports (dashboards) this person can see, with their pages, dates, version and who changed them last.",
    level: "read",
    inputSchema: schema({ limit: limitInput(100, 500), cursor: CURSOR }),
    async run(tx, args, context) {
      await requireAnalytics(tx);
      const page = pageByPosition(await listDashboards(tx, readerOf(tx, context)), args.cursor, boundedLimit(args.limit, 100, 500));
      return { dashboards: page.rows.map(dashboardSummary), more: page.more, nextCursor: page.nextCursor };
    },
  },
  stepped({
    name: "get_analytics_dashboard",
    title: "Get an Analytics report with its figures",
    description:
      "One report: its dates, slicers and pages, and each tile as saved (the same shape the create and update tools take) with its figures in the report's dates. A tile that no longer works says why.",
    level: "read",
    inputSchema: schema(
      {
        dashboardId: { type: "string" },
        page: FIELD("Only the tiles on this page."),
        rows: { type: "integer", minimum: 1, maximum: 200, description: "At most this many rows for each tile (default 20)." },
      },
      ["dashboardId"],
    ),
    async runSteps(run, args, context) {
      const facts = await run(async (tx) => {
        await requireAnalytics(tx);
        const dashboard = await getDashboard(tx, String(args.dashboardId ?? ""), readerOf(tx, context));
        const freshness = (await reportLoadFacts(tx, dashboard)).map(({ name, tables, refreshedAt, failedAt, failedReason, running }) => ({ name, tables, refreshedAt, failedAt, ...(failedReason ? { failedReason } : {}), running }));
        return { organisationId: tx.organisationId, dashboard, freshness, dates: await dateContext(tx), model: await loadModel(tx), hidden: await hiddenFarmTables(tx) };
      });
      const { dashboard } = facts;
      const tiles = typeof args.page === "string" && args.page ? dashboard.tiles.filter((tile) => tilePage(tile, dashboard.settings.pages) === args.page) : dashboard.tiles;
      const runs = await runTiles(facts.organisationId, tiles, dashboard.settings, { today: facts.dates.today, yearEndMonth: facts.dates.yearEndMonth }, facts.model, facts.hidden);
      const rows = boundedLimit(args.rows, 20, 200);
      return {
        dashboard: dashboardSummary(dashboard),
        theme: dashboard.settings.theme ?? "tohyee",
        slicers: dashboard.settings.slicers.map((slicer) => ({ table: slicer.table, field: slicer.field, label: slicer.label, ...(slicer.style ? { style: slicer.style } : {}), ...(slicer.pages ? { pages: slicer.pages } : {}) })),
        // When each source was last refreshed, and whether a refresh failed or is running (decision 698).
        freshness: facts.freshness,
        tiles: runs.map((entry) => ({ ...tileOut(entry.tile), ...(entry.result ? { figures: figures(entry.result, rows) } : {}), ...(entry.error ? { error: entry.error } : {}) })),
      };
    },
  }),
];

/** The templates this organisation's tables allow, for analytics_format_guide and create_analytics_dashboard_from_template. */
async function templateFacts(run: OrgRunner) {
  const facts = await run(async (tx) => {
    await requireAnalytics(tx);
    return { organisationId: tx.organisationId, hidden: await hiddenFarmTables(tx), model: await loadModel(tx), dates: await dateContext(tx), themes: await listThemes(tx) };
  });
  const tables = (await describeTables(facts.organisationId, facts.model)).filter((table) => !facts.hidden?.has(table.name));
  // The looks a report can take (#690): Tohyee's own, then the organisation's saved ones.
  const themes = [
    ...BUILT_IN_IDS.map((id) => ({ id: id as string, name: BUILT_IN_THEMES[id].name, kind: "built in" })),
    ...facts.themes.map((saved) => ({ id: `${CUSTOM_PREFIX}${saved.id}`, name: saved.theme.name, kind: "saved by this organisation" })),
  ];
  return { tables, today: facts.dates.today, themes };
}

ANALYTICS_READ_TOOLS.push(
  stepped({
    name: "analytics_format_guide",
    title: "How to make an Analytics report look good",
    description:
      "Read this before building or restyling a report: how to lay one out, every format key a tile takes (number formats, subtitles, key figure comparisons, colours, rules, table styles), worked examples to copy, and the ready-made templates this organisation's data allows.",
    level: "read",
    inputSchema: schema({}),
    async runSteps(run, _args, context) {
      requireTablesAllowed(context);
      const { tables, today, themes } = await templateFacts(run);
      return {
        layout: LAYOUT_ADVICE,
        themes,
        themesNote: "Set a report's theme with theme on create_analytics_dashboard or update_analytics_dashboard. One theme a report: it colours every chart on it.",
        reportControls: "pages (tabs, or slides when presented) and slicers (filters a reader changes) are set on create and update too. Two or three short pages read better than one long one; add a slicer for the one or two things a reader will want to narrow by.",
        format: FORMAT_SCHEMA.properties,
        examples: FORMAT_EXAMPLES,
        widths: [...TILE_WIDTHS],
        heights: [...TILE_HEIGHTS],
        templates: TEMPLATES.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
          available: buildTemplate(template.id, tables, today) !== null,
          ...(buildTemplate(template.id, tables, today) === null ? { needs: template.needs } : {}),
        })),
        templatesNote: "create_analytics_dashboard_from_template makes a report from one, which you then change with update_analytics_dashboard. A template is the quickest way to a well laid out report.",
      };
    },
  }),
);

export const ANALYTICS_WRITE_TOOLS: AiTool[] = [
  stepped({
    name: "create_analytics_dashboard_from_template",
    title: "Make an Analytics report from a template",
    description:
      "Makes a new report from one of Tohyee's ready-made templates (analytics_format_guide lists the ones this organisation's data allows): laid out, formatted and dated for the last 12 months. Every tile is run first. Then change it with update_analytics_dashboard.",
    level: "draft",
    inputSchema: schema(
      {
        template: { type: "string", enum: TEMPLATES.map((template) => template.id) },
        name: { type: "string", maxLength: 100, description: "Default the template's own name." },
        description: { type: "string", maxLength: 500 },
      },
      ["template"],
    ),
    async runSteps(run, args, context) {
      requireEditor(context);
      const template = TEMPLATES.find((entry) => entry.id === args.template);
      if (!template) throw new ValidationError(`Choose a template: ${TEMPLATES.map((entry) => entry.id).join(", ")}.`);
      const { tables, today } = await templateFacts(run);
      const built = buildTemplate(template.id, tables, today);
      if (!built) throw new ValidationError(`${template.name} needs data this organisation hasn't loaded: ${template.needs.join(", ")}. Nothing was saved.`);
      const checked = await checkAndRun(run, { settings: built.settings, tiles: built.tiles }, () => true);
      const name = typeof args.name === "string" && args.name.trim() ? args.name : built.name;
      const description = typeof args.description === "string" && args.description.trim() ? args.description : built.description;
      const dashboard = await run((tx) => createDashboard(tx, { name, description, settings: checked.settings, tiles: checked.tiles }));
      return saved(dashboard, checked.runs);
    },
  }),
  stepped({
    name: "create_analytics_dashboard",
    title: "Make an Analytics report",
    description:
      "Makes a new report under Analytics › Reports with up to 40 tiles, using the same chart kinds, measures, filters, dates and formats as the Analytics editor. Every tile is run first: if one doesn't work, nothing is saved and you're told which tile and why. Use list_analytics_tables first, and run_analytics_query to try questions.",
    level: "draft",
    inputSchema: schema(
      {
        name: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 500 },
        dates: REPORT_DATES,
        theme: REPORT_THEME,
        pages: REPORT_PAGES,
        slicers: REPORT_SLICERS,
        tiles: { type: "array", minItems: 1, maxItems: 40, items: TILE },
      },
      ["name", "tiles"],
    ),
    async runSteps(run, args, context) {
      requireEditor(context);
      const settings = settingsAsked(null, args) ?? { preset: null, from: null, to: null, slicers: [] };
      const tiles = Array.isArray(args.tiles) ? args.tiles : [];
      if (tiles.length === 0) throw new ValidationError("Give the report at least one tile.");
      const checked = await checkAndRun(run, { settings, tiles }, () => true);
      const dashboard = await run((tx) => createDashboard(tx, { name: args.name, description: args.description, settings, tiles: checked.tiles }));
      return saved(dashboard, checked.runs);
    },
  }),
  stepped({
    name: "suggest_analytics_commentary",
    title: "Add commentary to an Analytics report",
    description:
      "Adds a commentary box to a report: a few plain sentences on what the figures show, beside the tile they're about (aboutTileId) or at the end of a page. It's shown as suggested by the AI, not checked, until a person accepts or removes it in Tohyee; report viewers see it only once accepted. Read the report with get_analytics_dashboard first and write only what its figures support, with the figures and dates you used. Bold, lists and links work (**bold**, - item).",
    level: "draft",
    inputSchema: schema(
      {
        dashboardId: { type: "string" },
        text: { type: "string", maxLength: 4000, description: "The commentary: 2 to 5 short sentences, or a short list." },
        aboutTileId: { ...TILE_ID, description: "The tile it's about: the box goes straight after it, on its page. Leave out for the whole page." },
        title: { type: "string", maxLength: 100, description: "Default \"Commentary: \" and the tile's title." },
        page: { type: "string", description: "With no aboutTileId: the page it goes at the end of; default the first." },
        width: { type: "string", enum: [...TILE_WIDTHS], description: "Default the tile's own width, or full." },
        expectedVersion: { type: "integer", minimum: 1, description: "The version you read; the save is refused if someone has saved since." },
      },
      ["dashboardId", "text"],
    ),
    async runSteps(run, args, context) {
      requireEditor(context);
      if (typeof args.text === "string" && args.text.length > 4000) throw new ValidationError("Commentary can be up to 4,000 characters. Nothing was saved.");
      const result = await run((tx) =>
        suggestCommentary(tx, String(args.dashboardId ?? ""), { text: args.text, title: args.title, aboutTileId: args.aboutTileId, page: args.page, width: args.width, expectedVersion: args.expectedVersion }, tx.actor.via ?? "the AI"),
      );
      return {
        dashboard: dashboardSummary(result.dashboard),
        tileId: result.tileId,
        note: "Added as suggested by the AI, not checked. A person accepts or removes it on the report in Tohyee; until then report viewers don't see it. To change the words, a person edits the box, or remove it and suggest again.",
      };
    },
  }),
  stepped({
    name: "update_analytics_dashboard",
    title: "Change an Analytics report",
    description:
      "Changes a report: its name, description or dates; adds tiles (at a position); changes tiles by id (only the fields you send; query replaces the whole question); puts tiles in a new order; takes tiles off (removeTiles); and sets its theme, pages and slicers. Tiles you add or change are run first: if one doesn't work, nothing is saved. Read it with get_analytics_dashboard first and pass its version as expectedVersion, so you don't save over someone else's change. People delete reports and change sharing and images in Tohyee.",
    level: "draft",
    inputSchema: schema(
      {
        dashboardId: { type: "string" },
        expectedVersion: { type: "integer", minimum: 1, description: "The version you read; the save is refused if someone has saved since." },
        name: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 500 },
        dates: REPORT_DATES,
        addTiles: {
          type: "array",
          maxItems: 40,
          items: { ...TILE, properties: { ...(TILE.properties as Record<string, JsonSchema>), position: { type: "integer", minimum: 1, description: "Where it goes: 1 is first. Default at the end." } } },
        },
        changeTiles: {
          type: "array",
          maxItems: 40,
          items: { type: "object", properties: { tileId: TILE_ID, ...TILE_PROPERTIES }, required: ["tileId"], description: "The fields to change on one tile; null clears format, dates or height." },
        },
        order: { type: "array", maxItems: 40, items: TILE_ID, description: "Tile ids in the order you want; tiles you leave out follow them in their current order." },
        removeTiles: { type: "array", maxItems: 40, items: TILE_ID, description: "Tiles to take off the report. A person can put them back from the report's History." },
        theme: REPORT_THEME,
        pages: REPORT_PAGES,
        slicers: REPORT_SLICERS,
      },
      ["dashboardId"],
    ),
    async runSteps(run, args, context) {
      requireEditor(context);
      const current = await run(async (tx) => {
        await requireAnalytics(tx);
        return getDashboard(tx, String(args.dashboardId ?? ""));
      });
      if (args.expectedVersion !== undefined && args.expectedVersion !== current.version) {
        throw new ValidationError(`${current.updatedByEmail} saved this report (version ${current.version}) after the version you read (${String(args.expectedVersion)}). Read it again with get_analytics_dashboard, then make your change. Nothing was saved.`);
      }
      const ids = new Set(current.tiles.map((tile) => tile.id));
      let tiles: Array<Record<string, unknown>> = current.tiles.map((tile) => ({ ...tile }));
      const touched = new Set<string>();
      // Taking tiles off (#690): the report's History keeps them, so a person can put them back.
      const removing = Array.isArray(args.removeTiles) ? args.removeTiles.map(String) : [];
      for (const id of removing) {
        const tile = tiles.find((entry) => entry.id === id);
        if (!tile) throw new ValidationError(`removeTiles: there's no tile ${id} on this report (get_analytics_dashboard lists them). Nothing was saved.`);
        // An image's file goes with its tile, so History couldn't bring it back.
        if (tile.visual === "image") throw new ValidationError(`removeTiles: ${String(tile.title)} is an image, which people remove in Tohyee. Nothing was saved.`);
      }
      if (removing.length) {
        tiles = tiles.filter((tile) => !removing.includes(String(tile.id)));
        for (const id of removing) ids.delete(id);
        if (tiles.length === 0 && !(Array.isArray(args.addTiles) && args.addTiles.length)) throw new ValidationError("removeTiles: that would leave the report empty. People delete reports in Tohyee. Nothing was saved.");
      }
      for (const [index, raw] of (Array.isArray(args.changeTiles) ? args.changeTiles : []).entries()) {
        const change = (raw ?? {}) as Record<string, unknown>;
        const at = tiles.findIndex((tile) => tile.id === change.tileId);
        if (at < 0) throw new ValidationError(`changeTiles ${index + 1}: there's no tile ${String(change.tileId)} on this report (get_analytics_dashboard lists them). Nothing was saved.`);
        if (tiles[at].visual === "image") throw new ValidationError(`changeTiles ${index + 1}: ${String(tiles[at].title)} is an image, which people change in Tohyee. Nothing was saved.`);
        const next: Record<string, unknown> = { ...tiles[at] };
        for (const [field, value] of Object.entries(change)) {
          if (field === "tileId") continue;
          if (value === null) delete next[field];
          else next[field] = value;
        }
        tiles[at] = next;
        touched.add(String(change.tileId));
      }
      const adds = Array.isArray(args.addTiles) ? args.addTiles : [];
      for (const [index, raw] of adds.entries()) {
        const { position, ...tile } = (raw ?? {}) as Record<string, unknown>;
        if (typeof tile.id === "string" && ids.has(tile.id)) throw new ValidationError(`addTiles ${index + 1}: the id ${tile.id} is already a tile on this report. Choose another, or use changeTiles. Nothing was saved.`);
        const id = typeof tile.id === "string" ? tile.id : `ai-${Date.now().toString(36)}-${index}`;
        ids.add(id);
        touched.add(id);
        const at = typeof position === "number" && Number.isInteger(position) ? Math.min(Math.max(position - 1, 0), tiles.length) : tiles.length;
        tiles.splice(at, 0, { ...tile, id });
      }
      if (Array.isArray(args.order) && args.order.length) {
        const wanted = args.order.map(String);
        const unknown = wanted.find((id) => !ids.has(id));
        if (unknown) throw new ValidationError(`order: there's no tile ${unknown} on this report. Nothing was saved.`);
        if (new Set(wanted).size !== wanted.length) throw new ValidationError("order: name each tile once. Nothing was saved.");
        tiles = [...wanted.map((id) => tiles.find((tile) => tile.id === id)!), ...tiles.filter((tile) => !wanted.includes(String(tile.id)))];
      }
      const asked = settingsAsked(current.settings, args);
      const settings = asked ?? current.settings;
      const checked = await checkAndRun(run, { settings, tiles }, (tile) => touched.has(String(tile.id)));
      const dashboard = await run((tx) =>
        updateDashboard(tx, current.id, {
          expectedVersion: current.version,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(asked ? { settings: checked.settings } : {}),
          tiles: checked.tiles,
        }),
      );
      return saved(dashboard, checked.runs);
    },
  }),
  stepped({
    name: "refresh_analytics_sources",
    title: "Refresh Analytics data",
    description:
      "Loads the latest data into Analytics now, as Refresh now and Load now do in Tohyee: for the tables you name, or every source a report's tiles read. It only fetches data again: it never changes a connection, its sign-in, its query or its schedule. Each source answers when it started and finished, the rows loaded, or why it didn't (for example it's already loading). It waits until each load is done; get_analytics_dashboard's freshness shows the state afterwards. Owners and admins only, as in Tohyee.",
    level: "draft",
    minRole: "admin",
    inputSchema: schema({
      dashboardId: { type: "string", description: "Refresh every source this report's tiles read." },
      tables: { type: "array", maxItems: 20, items: { type: "string" }, description: "Or the tables to refresh (list_analytics_tables names them)." },
    }),
    async runSteps(run, args, context) {
      if (!roleAtLeast(context.role, "admin")) throw new ForbiddenError("Refreshing Analytics data is for owners and admins, as in Tohyee.");
      if (!context.organisation || !context.actor) throw new ValidationError("Refreshing data needs a connection to Tohyee.");
      const plan = await run(async (tx) => {
        await requireAnalytics(tx);
        let tables: string[];
        if (args.dashboardId !== undefined && args.dashboardId !== null && args.dashboardId !== "") {
          const dashboard = await getDashboard(tx, String(args.dashboardId));
          tables = [...new Set(dashboard.tiles.flatMap((tile) => (tile.query ? [tile.query.table] : [])))];
          if (tables.length === 0) throw new ValidationError("That report has no tiles that read a table.");
        } else if (Array.isArray(args.tables) && args.tables.length) {
          tables = [...new Set(args.tables.map(String))];
        } else {
          throw new ValidationError("Give dashboardId or tables.");
        }
        const sources = await listSources(tx);
        const shapes = await listShapedTables(tx);
        const hidden = await hiddenFarmTables(tx);
        // One load for each source, however many of its tables were named.
        const loads = new Map<string, { label: string; tables: string[]; kind: string; id?: string }>();
        const skipped: Array<{ table: string; reason: string }> = [];
        for (const table of tables) {
          if (hidden?.has(table)) {
            skipped.push({ table, reason: "Farm tables are for members who see every farm." });
            continue;
          }
          const key = loadKeyOf(table).tableName;
          const builtIn: Record<string, string> = { [BOOKS_TABLE_NAME]: "books", [SHOPIFY_LOAD_TABLE_NAME]: "shopify", [GA_LOAD_TABLE_NAME]: "ga", [GSC_LOAD_TABLE_NAME]: "gsc", [META_LOAD_TABLE_NAME]: "meta" };
          const source = sources.find((entry) => entry.tableName === table);
          const shape = shapes.find((entry) => entry.tableName === table);
          const plan = builtIn[key]
            ? { key, kind: builtIn[key], label: BUILT_IN_NAMES[builtIn[key]] }
            : source
              ? { key: `source-${source.id}`, kind: "source", id: source.id, label: source.name }
              : shape
                ? { key: `shape-${shape.id}`, kind: "shape", id: shape.id, label: shape.name }
                : null;
          if (!plan) {
            skipped.push({ table, reason: "There's no source that loads this table." });
            continue;
          }
          const entry = loads.get(plan.key) ?? { label: plan.label, tables: [], kind: plan.kind, ...(plan.id ? { id: plan.id } : {}) };
          entry.tables.push(table);
          loads.set(plan.key, entry);
        }
        return { loads: [...loads.values()], skipped };
      });
      const organisation = context.organisation;
      const actor = context.actor;
      const results = [];
      for (const load of plan.loads) {
        try {
          const loaded: LoadRun | Awaited<ReturnType<typeof runShapedTableAndDependents>> =
            load.kind === "books"
              ? await refreshBooks(organisation, actor, "manual")
              : load.kind === "shopify"
                ? await refreshShopify(organisation, actor, "manual")
                : load.kind === "ga"
                  ? await refreshGa(organisation, actor, "manual")
                  : load.kind === "gsc"
                    ? await refreshGsc(organisation, actor, "manual")
                    : load.kind === "meta"
                      ? await refreshMeta(organisation, actor, "manual")
                      : load.kind === "source"
                        ? await runLoad(organisation, actor, load.id!, "manual")
                        : await runShapedTableAndDependents(organisation, actor, load.id!);
          results.push({
            source: loaded.sourceName,
            tables: load.tables,
            status: loaded.status,
            startedAt: loaded.startedAt,
            finishedAt: loaded.finishedAt,
            rowsLoaded: loaded.rowsLoaded,
            ...(loaded.error ? { error: loaded.error } : {}),
          });
        } catch (error) {
          results.push({ source: load.label, tables: load.tables, status: "not started", error: problem(error) });
        }
      }
      return {
        refreshed: results,
        ...(plan.skipped.length ? { skipped: plan.skipped } : {}),
        note: "A load that fails leaves the last good data in place. Nothing about the sources' connections or schedules was changed.",
      };
    },
  }),
];

/** Every Analytics tool, for the module switch (offered only while Analytics is on). */
export const ANALYTICS_TOOL_NAMES: readonly string[] = [...ANALYTICS_READ_TOOLS, ...ANALYTICS_WRITE_TOOLS].map((tool) => tool.name);
