import { ValidationError } from "@/lib/errors";
import { addDays, financialYearStart } from "@/lib/financial-year";
import { addMonthsToMonthStart } from "@/lib/analytics/date-ranges";
import type { Filter, Grain, TileQuery } from "@/lib/analytics/query";

/**
 * What a reader is looking at in a report beyond its dates and slicers
 * (#376 phase 3, decisions 754-756): drilling down a tile's hierarchy,
 * clicking a group to filter or highlight other tiles, and drilling through
 * to another page. Browser-safe; the server works out each tile's question
 * from this and the report as saved, so none of it can ask for more than
 * the report's own tiles show (decision 756).
 */

export type DrillLevel = { field: string; grain?: Grain };

/** Chart types a reader can drill down and click to filter by (one group per mark or row). */
export const DRILLABLE: string[] = ["column", "bar", "line", "area", "combo", "pie", "donut", "table", "funnel", "treemap", "waterfall", "bullet"];
/** A tile's hierarchy: what it's grouped by first, then each level down (2 to 4 levels). */
export type TileDrill = { levels: DrillLevel[] };
export const MAX_DRILL_LEVELS = 4;

/** Year, quarter, month, day: by financial year (the organisation's balance date) or calendar year. */
export function dateHierarchy(field: string, financial: boolean): DrillLevel[] {
  return (financial ? (["fyear", "fquarter", "month", "day"] as Grain[]) : (["year", "quarter", "month", "day"] as Grain[])).map((grain) => ({ field, grain }));
}

const DATE_GRAINS: Grain[] = ["year", "fyear", "quarter", "fquarter", "month", "week", "day"];

/** Checks a tile's hierarchy against its first grouping and its table's columns. */
export function parseDrill(input: unknown, groupBy: TileQuery["groupBy"], isDateField: (field: string) => boolean | undefined, what: string): TileDrill | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (!Array.isArray(raw.levels)) throw new ValidationError(`${what}: the drill-down levels aren't set up properly.`);
  if (raw.levels.length < 2 || raw.levels.length > MAX_DRILL_LEVELS) throw new ValidationError(`${what}: drilling down needs 2 to ${MAX_DRILL_LEVELS} levels.`);
  if (!groupBy) throw new ValidationError(`${what}: group the chart by something to drill down.`);
  const seen = new Set<string>();
  const levels = raw.levels.map((entry, index): DrillLevel => {
    const level = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const field = typeof level.field === "string" ? level.field : "";
    const date = isDateField(field);
    if (date === undefined) throw new ValidationError(`${what}: drill-down level ${index + 1} needs a column of the chart's table.`);
    let grain: Grain | undefined;
    if (date) {
      if (!DATE_GRAINS.includes(level.grain as Grain)) throw new ValidationError(`${what}: choose how drill-down level ${index + 1} groups its dates.`);
      grain = level.grain as Grain;
    }
    const key = `${field}|${grain ?? ""}`;
    if (seen.has(key)) throw new ValidationError(`${what}: each drill-down level should be different.`);
    seen.add(key);
    return grain ? { field, grain } : { field };
  });
  if (levels[0].field !== groupBy.field || (levels[0].grain ?? null) !== (groupBy.grain ?? null)) throw new ValidationError(`${what}: the first drill-down level is what the chart is grouped by.`);
  return { levels };
}

/** Where a reader is in a tile's hierarchy: the level shown and the value chosen at each level above it ("all" when expanded). */
export type DrillState = { level: number; path: Array<string | null>; all?: boolean };
export const TOP: DrillState = { level: 0, path: [] };

export function drillDown(state: DrillState, value: string | null, levels: number): DrillState {
  if (state.level >= levels - 1) return state;
  return { level: state.level + 1, path: [...state.path.slice(0, state.level), value], ...(state.all ? { all: true } : {}) };
}

export function drillUp(state: DrillState): DrillState {
  if (state.level === 0) return state;
  const level = state.level - 1;
  const path = state.path.slice(0, level);
  return level === 0 ? TOP : { level, path, ...(state.all ? { all: true } : {}) };
}

/** Power BI's "expand all down one level": the next level for every group above, not just one. */
export function expandAll(state: DrillState, levels: number): DrillState {
  if (state.level >= levels - 1) return state;
  return { level: state.level + 1, path: state.path.slice(0, state.level), all: true };
}

/** The first day after a period that starts on `start`. */
export function periodEnd(start: string, grain: Grain): string {
  switch (grain) {
    case "day":
      return addDays(start, 1);
    case "week":
      return addDays(start, 7);
    case "month":
      return addMonthsToMonthStart(start, 1);
    case "quarter":
    case "fquarter":
      return addMonthsToMonthStart(start, 3);
    case "year":
    case "fyear":
      return addMonthsToMonthStart(start, 12);
  }
}

/** The start of the period (by a grain) a date is in; financial ones by the balance date. */
export function periodStart(date: string, grain: Grain, yearEndMonth: number): string {
  const month = `${date.slice(0, 7)}-01`;
  switch (grain) {
    case "day":
      return date;
    case "week": {
      // Weeks start on Monday, as DuckDB's date_trunc('week') does.
      const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
      return addDays(date, -weekday);
    }
    case "month":
      return month;
    case "quarter":
      return addMonthsToMonthStart(month, -((Number(date.slice(5, 7)) - 1) % 3));
    case "year":
      return `${date.slice(0, 4)}-01-01`;
    case "fyear":
      return financialYearStart(date, yearEndMonth);
    case "fquarter": {
      const start = financialYearStart(date, yearEndMonth);
      const months = (Number(date.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(start.slice(5, 7));
      return addMonthsToMonthStart(start, Math.floor(months / 3) * 3);
    }
  }
}

/** What a period is called: "FY2027" (named by the year it ends, as Xero does), "FY2027 Q1", "2026", "Q3 2026", "Jun 2026" or "3 Jun 2026". */
export function periodLabel(start: string, grain: Grain | undefined, yearEndMonth: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return start;
  const date = new Date(`${start}T00:00:00Z`);
  const month = new Intl.DateTimeFormat("en-NZ", { month: "short", year: "numeric", timeZone: "UTC" });
  const fyName = (yearStart: string) => {
    const end = addDays(addMonthsToMonthStart(yearStart, 12), -1);
    return `FY${end.slice(0, 4)}`;
  };
  switch (grain) {
    case "year":
      return start.slice(0, 4);
    case "quarter":
      return `Q${Math.floor((date.getUTCMonth()) / 3) + 1} ${start.slice(0, 4)}`;
    case "fyear":
      return fyName(financialYearStart(start, yearEndMonth));
    case "fquarter": {
      const yearStart = financialYearStart(start, yearEndMonth);
      const months = (Number(start.slice(0, 4)) - Number(yearStart.slice(0, 4))) * 12 + Number(start.slice(5, 7)) - Number(yearStart.slice(5, 7));
      return `${fyName(yearStart)} Q${Math.floor(months / 3) + 1}`;
    }
    case "month":
      return month.format(date);
    case "week":
      return `Week of ${new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date)}`;
    default:
      return new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  }
}

/** The filters that keep only one group of a level: a value, a blank, or a period's dates. */
export function valueFilters(level: DrillLevel, value: string | null): Filter[] {
  if (value === null) return [{ field: level.field, op: "blank", value: "" }];
  if (level.grain) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError("A date group is YYYY-MM-DD.");
    return [
      { field: level.field, op: "gte", value },
      { field: level.field, op: "lt", value: periodEnd(value, level.grain) },
    ];
  }
  return [{ field: level.field, op: "eq", value }];
}

function levelsOf(query: TileQuery | null, drill: TileDrill | undefined): DrillLevel[] {
  if (drill?.levels.length) return drill.levels;
  return query?.groupBy ? [query.groupBy] : [];
}

/** A tile's grouping at a drill state, and the filters for the groups chosen above it. */
export function drillView(query: TileQuery, drill: TileDrill | undefined, state: DrillState | undefined, what: string): { groupBy: TileQuery["groupBy"]; filters: Filter[] } {
  const levels = levelsOf(query, drill);
  if (!state || state.level === 0) return { groupBy: query.groupBy, filters: [] };
  if (!Number.isInteger(state.level) || state.level < 0 || state.level >= levels.length) throw new ValidationError(`${what} can't drill down that far.`);
  if (state.path.length > state.level || (!state.all && state.path.length !== state.level)) throw new ValidationError(`${what}: choose a group at each level above.`);
  const filters = state.path.flatMap((value, index) => valueFilters(levels[index], value));
  return { groupBy: levels[state.level], filters };
}

/** A click on one of a tile's groups, at whatever level it's drilled to. */
export type Selection = { tileId: string; value: string | null; drill?: DrillState };

/** How a click on a tile changes another (Power BI's "edit interactions"). */
export const INTERACTION_MODES = ["filter", "highlight", "none"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];
export const INTERACTION_LABELS: Record<InteractionMode, string> = { filter: "Filter", highlight: "Highlight", none: "No change" };

type ViewTile = { id: string; title: string; query: TileQuery | null; drill?: TileDrill; interactions?: Record<string, InteractionMode> };

/** How clicking `source` changes `target`: as set on the source, or filter (the default). */
export function interactionMode(source: Pick<ViewTile, "interactions">, targetId: string): InteractionMode {
  return source.interactions?.[targetId] ?? "filter";
}

/** The field and grain a selection picked, worked out from the saved tile it was made on (never from the request). */
export function selectionLevel(tiles: ViewTile[], selection: Selection): { level: DrillLevel; filters: Filter[] } {
  const source = tiles.find((tile) => tile.id === selection.tileId);
  if (!source?.query?.groupBy) throw new ValidationError("That chart isn't on this report, or it can't be clicked to filter.");
  const view = drillView(source.query, source.drill, selection.drill, source.title);
  return { level: view.groupBy!, filters: [...view.filters, ...valueFilters(view.groupBy!, selection.value)] };
}

/** What a tile is asked to show: its drill state, the groups clicked on other tiles, and a drill-through value. */
export type TileView = { drill?: DrillState; selections?: Selection[]; through?: Selection[] };
const MAX_SELECTIONS = 8;

function parseDrillState(input: unknown): DrillState | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const level = Number(raw.level);
  const path = Array.isArray(raw.path) ? raw.path : [];
  if (!Number.isInteger(level) || level < 0 || level >= MAX_DRILL_LEVELS || path.length > MAX_DRILL_LEVELS) throw new ValidationError("The drill-down isn't set up properly.");
  return { level, path: path.map(parseValue), ...(raw.all === true ? { all: true } : {}) };
}

function parseValue(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new ValidationError("A chosen group should be text.");
  const text = String(value);
  if (text.length > 500) throw new ValidationError("A chosen group is too long.");
  return text;
}

function parseSelections(input: unknown): Selection[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_SELECTIONS) throw new ValidationError(`Up to ${MAX_SELECTIONS} groups can be chosen at once.`);
  return input.map((entry) => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    if (typeof raw.tileId !== "string") throw new ValidationError("A chosen group needs its chart.");
    const drill = parseDrillState(raw.drill);
    return { tileId: raw.tileId, value: parseValue(raw.value), ...(drill ? { drill } : {}) };
  });
}

/** A view from a request: only its shape is checked here; what it may ask for is checked against the report in `viewQuery`. */
export function parseTileView(input: unknown): TileView | undefined {
  if (input === undefined || input === null) return undefined;
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const drill = parseDrillState(raw.drill);
  const selections = parseSelections(raw.selections);
  const through = parseSelections(raw.through);
  return { ...(drill ? { drill } : {}), ...(selections.length ? { selections } : {}), ...(through.length ? { through } : {}) };
}

/**
 * A saved tile's question as viewed (decision 756): its grouping can only
 * become one of its own saved drill-down levels, and every filter a click,
 * drill or drill-through adds is "and"-ed on, worked out from the report's
 * own saved tiles. So a view can narrow a tile but never widen it, and it
 * can only filter by a field some tile of the report groups by.
 */
export function viewQuery(tiles: ViewTile[], tile: ViewTile, view: TileView | undefined): { query: TileQuery; where: Filter[] } {
  if (!tile.query) throw new ValidationError("This tile has no question.");
  if (!view) return { query: tile.query, where: [] };
  const drilled = drillView(tile.query, tile.drill, view.drill, tile.title);
  const where = [...drilled.filters];
  for (const selection of [...(view.selections ?? []), ...(view.through ?? [])]) {
    if (selection.tileId === tile.id) continue;
    where.push(...selectionLevel(tiles, selection).filters);
  }
  // A level that isn't dates can't compare with last year; the tile's order and Top N stay.
  const query: TileQuery =
    drilled.groupBy === tile.query.groupBy
      ? tile.query
      : {
          ...tile.query,
          groupBy: drilled.groupBy,
          measures: drilled.groupBy?.grain ? tile.query.measures : tile.query.measures.map((measure) => (measure.compare === "previous_year" ? { ...measure, compare: undefined } : measure)),
        };
  return { query, where };
}
