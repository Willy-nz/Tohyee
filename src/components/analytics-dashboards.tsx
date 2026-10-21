"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { ChartFormatPanel } from "@/components/analytics/chart-format-panel";
import { KeyFigureView } from "@/components/analytics/key-figure";
import { KeyFigureSettings } from "@/components/analytics/key-figure-settings";
import { FormulaField, SavedValuesPicker, SaveValueButton, ValueRules } from "@/components/analytics/saved-values";
import { PinTileMenu } from "@/components/analytics/pin-tile-menu";
import { isTohyee, ReportThemeStyle, reportTheme } from "@/components/analytics/report-theme";
import { ThemePanel } from "@/components/analytics/theme-panel";
import { FormattedCell, tableLook, totalRowClass } from "@/components/analytics/table-look";
import { columnRange, tableTotals, visiblePivotRows } from "@/lib/analytics/conditional";
import { columnHeaderRows, columnPathText, initiallyCollapsed, isGroupRow, steppedRows, visibleWithCollapsed } from "@/lib/analytics/matrix";
import { TileFilters } from "@/components/analytics/tile-filters";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { formatOptionsFor, mergeFormats, pasteFormat, SECOND_GROUPING, SECOND_GROUPING_REQUIRED, VISUAL_NAMES, type ChartFormat, type DefaultableVisual, type VisualDefaults } from "@/lib/analytics/chart-format";
import { tileChartSpec, tileValueNames, tileWithDefaults } from "@/lib/analytics/tile-chart";
import { cardStyle, chartGroupNames, datedGroups } from "@/lib/analytics/chart-spec";
import { calendarHeight, calendarYears } from "@/lib/analytics/chart-relationships";
import { MAP_ATTRIBUTION, mapNote } from "@/lib/analytics/maps";
import { additiveValues } from "@/lib/analytics/small-multiples";
import { SmallMultiplesView } from "@/components/analytics/small-multiples";
import { useTileResult } from "@/components/analytics/use-tile-result";
import { ButtonItemView, ImageItemView, ItemEditor, ShapeItemView, TextItemView } from "@/components/analytics/items";
import { isItemVisual, type ButtonAction } from "@/lib/analytics/items";
import { PanelTabs } from "@/components/analytics/panel-tabs";
import { ArrangeBar } from "@/components/analytics/arrange-bar";
import { PageTabs, pageStyle } from "@/components/analytics/report-pages";
import { SlicerControl } from "@/components/analytics/slicer-control";
import { SLICER_STYLE_LABELS, slicerOnPage, stylesFor, type SlicerRange, type SlicerStyle } from "@/lib/analytics/slicers";
import { effectiveDates, tileDatesText, type PageFilter, type TileDates } from "@/lib/analytics/report-filters";
import { bookmarkName, type Bookmark, type BookmarkState } from "@/lib/analytics/bookmarks";
import { addPage, movePage, openingPage, removePage, reportPages, tilePage, tilesOnPage, withPage, type ReportPage } from "@/lib/analytics/pages";
import { isSpecialistVisual, PANEL_TAB_LABELS, PANEL_TABS, type PanelTab } from "@/lib/analytics/editor-panels";
import { dateHierarchy, DRILLABLE, INTERACTION_LABELS, INTERACTION_MODES, MAX_DRILL_LEVELS, drillDown, drillUp, drillView, expandAll, interactionMode, periodLabel, selectionLevel, TOP, type DrillState, type InteractionMode, type Selection, type TileDrill, type TileView } from "@/lib/analytics/report-view";

/** Each small chart's height, by the tile's height. */
const MULTIPLE_HEIGHTS: Record<TileHeight, number> = { small: 160, medium: 200, large: 260 };
import type { ReportTheme } from "@/lib/charts/report-themes";
import { buildTemplate, TEMPLATES, type TemplateId } from "@/lib/analytics/templates";
import { todayIsoDate } from "@/lib/dates";
import type { Dashboard, DashboardSettings, Slicer, Tile } from "@/lib/analytics/dashboards";
import { CHART_HEIGHTS, HEIGHT_LABELS, TILE_HEIGHTS, TILE_WIDTHS, WIDTH_LABELS, duplicateTile, moveTileTo, type TileHeight, type TileWidth } from "@/lib/analytics/layout";
import type {
  Aggregate,
  Filter,
  ColumnInfo,
  Grain,
  Measure,
  PivotColumn,
  PivotData,
  PivotDrillResult,
  PivotDrillSelection,
  PivotDimension,
  PivotGrain,
  PivotRow,
  QueryResult,
  ResultColumn,
  TileQuery,
  Visual,
} from "@/lib/analytics/query";
import { api, apiDownload, errorMessage } from "@/lib/client/api";
import { DATE_PRESETS, type DatePreset, isDatePreset, matchingPreset, presetRange } from "@/lib/analytics/date-ranges";
import { booleanText, showValue } from "@/lib/analytics/display";
import { filterComplete } from "@/lib/analytics/filters";
import { changeMeasure, fieldLabel, measureLabel, tableDescription, tableLabel } from "@/lib/analytics/labels";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import { cmp, dec, sum, toPlainString } from "@/lib/money/decimal";
import type { ReportExportData, ReportExportTable } from "@/lib/reports/export-types";
import styles from "./analytics-dashboards.module.css";

type TableInfo = { name: string; columns: ColumnInfo[] };

const VISUALS: Array<{ value: Visual; label: string }> = [
  { value: "column", label: "Columns" },
  { value: "bar", label: "Bars" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "combo", label: "Columns and line" },
  { value: "pie", label: "Pie" },
  { value: "donut", label: "Donut" },
  { value: "kpi", label: "Key figure" },
  { value: "table", label: "Table" },
  { value: "pivot", label: "Pivot table" },
  // #376 phase 2 (decision 676).
  { value: "waterfall", label: "Waterfall" },
  { value: "funnel", label: "Funnel" },
  { value: "gauge", label: "Gauge" },
  { value: "bullet", label: "Bullet chart" },
  { value: "scatter", label: "Scatter or bubble" },
  { value: "histogram", label: "Histogram" },
  { value: "boxplot", label: "Box plot" },
  { value: "treemap", label: "Treemap" },
  { value: "heatmap", label: "Heat map" },
  { value: "calendar", label: "Calendar heat map" },
  { value: "sankey", label: "Sankey" },
  { value: "filledmap", label: "Filled map (NZ)" },
  { value: "pointmap", label: "Map with points (NZ)" },
];

const ITEM_NAMES: Record<string, string> = { text: "Text", image: "Image", shape: "Shape", button: "Button" };

const AGGREGATES: Array<{ value: Aggregate; label: string }> = [
  { value: "sum", label: "Total" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Smallest" },
  { value: "max", label: "Largest" },
  { value: "count", label: "Count of rows" },
  { value: "count_distinct", label: "Count of different values" },
];

const GRAINS: Array<{ value: Grain; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

const PIVOT_GRAINS: Array<{ value: PivotGrain; label: string }> = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

const isDate = (type: string) => type === "DATE" || type.startsWith("TIMESTAMP");
const isNumber = (type: string) => /^(DECIMAL|BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|UBIGINT|UINTEGER)/.test(type);

/** "order_date" -> "Order date". */
function heading(label: string): string {
  const text = label.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A column in a picker: its plain name, with the real one in a tooltip (decision 577). */
function columnOptions(columns: ColumnInfo[], prefix = "") {
  return columns.map((column) => (
    <option key={column.name} value={column.name} title={column.name}>
      {prefix}{fieldLabel(column.name)}
    </option>
  ));
}

/**
 * Organisations seen with Analytics on in this tab. Coming back to a page,
 * it shows straight away while the setting is checked again, rather than
 * "Loading…" in place of the page and its buttons (#330).
 */
const analyticsSeenOn = new Set<string>();

function RequireAnalytics({ organisationId, children }: { organisationId: string; children: React.ReactNode }) {
  const modules = useModules(organisationId);
  const { can } = useWorkspace();
  if (modules?.analytics) analyticsSeenOn.add(organisationId);
  if (modules && !modules.analytics) analyticsSeenOn.delete(organisationId);
  if (!modules) return analyticsSeenOn.has(organisationId) ? <>{children}</> : <p className={ui.muted}>Loading…</p>;
  if (!modules.analytics) {
    return (
      <Notice tone="info">
        Analytics is off.{" "}
        {can("admin") ? (
          <>
            Turn it on in <Link href="/operations/settings">Settings › Modules</Link>.
          </>
        ) : (
          "An admin can turn it on in Settings."
        )}
      </Notice>
    );
  }
  return <>{children}</>;
}

/** Analytics › Dashboards: the list, and making a new one. */
export function DashboardsList({ organisationId }: { organisationId: string }) {
  return (
    <RequireAnalytics organisationId={organisationId}>
      <DashboardsListInner organisationId={organisationId} />
    </RequireAnalytics>
  );
}

function DashboardsListInner({ organisationId }: { organisationId: string }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const list = useApiData<{ dashboards: Dashboard[] }>("/api/analytics/dashboards", { organisationId });
  // Report viewers see only shared dashboards, not the tables (decision 360).
  const tables = useApiData<{ tables: TableInfo[] }>(can("viewer") ? "/api/analytics/tables" : null, { organisationId });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TemplateId | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // A template (#337) is an ordinary report filled with tiles, so everything can be changed after.
      const built = template ? buildTemplate(template, tables.data?.tables ?? [], todayIsoDate("Pacific/Auckland")) : null;
      const { dashboard } = await api<{ dashboard: Dashboard }>("/api/analytics/dashboards", {
        method: "POST",
        body: built
          ? { organisationId, name: name.trim() || built.name, description: built.description, settings: built.settings, tiles: built.tiles }
          : { organisationId, name: name.trim() || "Untitled report", tiles: [] },
      });
      router.push(`/analytics/dashboards/${dashboard.id}?edit=1`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  const noTables = tables.data && tables.data.tables.length === 0;
  const reports = (list.data?.dashboards ?? []).filter((report) => `${report.name} ${report.description ?? ""}`.toLowerCase().includes(search.toLowerCase().trim()))
    .slice().sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt));
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {creating ? <Card title="Create a report" description="Start blank or from a ready-made report, then add or change charts, key figures and pivot tables from your connected data.">
        <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <Field label="Report name"><input autoFocus value={name} maxLength={100} placeholder={template ? TEMPLATES.find((entry) => entry.id === template)?.name : "e.g. Sales and gross profit"} onChange={(event) => setName(event.target.value)} /></Field>
          <fieldset className={styles.templates}>
            <legend>Start from</legend>
            <label className={styles.template}>
              <input type="radio" name="template" checked={template === ""} onChange={() => setTemplate("")} />
              <span><strong>A blank report</strong><span className={ui.muted}>Add charts one at a time.</span></span>
            </label>
            {TEMPLATES.map((entry) => {
              const available = Boolean(tables.data && buildTemplate(entry.id, tables.data.tables, "2026-01-01"));
              return (
                <label key={entry.id} className={styles.template} aria-disabled={!available}>
                  <input type="radio" name="template" disabled={!available} checked={template === entry.id} onChange={() => setTemplate(entry.id)} />
                  <span>
                    <strong>{entry.name}</strong>
                    <span className={ui.muted}>{available ? entry.description : entry.id === "crm" ? "Needs the CRM, copied with the books (Data sources › Refresh now)." : entry.id === "farm" ? "Needs Farming, copied with the books (Data sources › Refresh now)." : "Needs the books copy (Data sources › Refresh now)."}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {noTables ? <Notice tone="info">Connect and load a <Link href="/analytics/sources">data source</Link> before adding charts.</Notice> : null}
          <div className={ui.rowButtons}><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create report"}</Button><Button variant="secondary" disabled={busy} onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      </Card> : null}
      <div className={styles.libraryToolbar}>
        <Field label="Search reports"><input type="search" placeholder="Find a report…" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
        <Field label="Sort by"><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">Last updated</option><option value="name">Name</option></select></Field>
        <div className={ui.rowButtons}><Button variant="secondary" aria-pressed={view === "grid"} onClick={() => setView("grid")}>Grid</Button><Button variant="secondary" aria-pressed={view === "list"} onClick={() => setView("list")}>List</Button></div>
        {can("bookkeeper") && !creating ? <Button onClick={() => setCreating(true)}>+ Create report</Button> : null}
      </div>
      {list.error ? <Notice tone="error">{list.error}</Notice> : !list.data ? <p className={ui.muted}>Loading reports…</p> : !reports.length ? <Empty>{search ? "No reports match your search." : can("bookkeeper") ? "Your first report starts here. Choose Create report to build it." : "No reports are available to you yet."}</Empty> : view === "list" ? (
        <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Report</th><th>Charts and tables</th><th>Last updated</th></tr></thead><tbody>{reports.map((report) => <tr key={report.id}><td><Link href={`/analytics/dashboards/${report.id}`}>{report.name}</Link><div className={ui.muted}>{report.description}</div></td><td>{report.tiles.length}</td><td>{formatDateTime(report.updatedAt)}</td></tr>)}</tbody></table></div>
      ) : <div className={styles.dashboardCards}>{reports.map((report) => <Link key={report.id} href={`/analytics/dashboards/${report.id}`} className={styles.dashboardCard}>
        <div className={styles.reportThumbnail} aria-hidden="true">{report.tiles.length ? report.tiles.slice(0, 4).map((tile) => <span key={tile.id}>{ITEM_NAMES[tile.visual] ?? VISUALS.find((visual) => visual.value === tile.visual)?.label ?? tile.visual}</span>) : <span>Blank report</span>}</div>
        <strong>{report.name}</strong>{report.description ? <span className={ui.muted}>{report.description}</span> : null}<span className={styles.reportMeta}>{report.tiles.length} charts and tables · {formatDateTime(report.updatedAt)}</span>
      </Link>)}</div>}
    </>
  );
}

/** What the dashboard is showing: its dates (and the preset they came from, if one was chosen) and slicer choices. */
type Filters = { from: string; to: string; preset?: DatePreset | null; values: Record<string, string[]>; ranges?: Record<string, SlicerRange> };
type DateContext = { today: string; financialYearEndMonth: number };
type PivotExportFor = { organisationId: string; organisationName: string; filters: Filters };

/** One dashboard: its date range and slicers, and its tiles; Edit to change them. */
export function DashboardView({ organisationId, dashboardId, startEditing }: { organisationId: string; dashboardId: string; startEditing: boolean }) {
  return (
    <RequireAnalytics organisationId={organisationId}>
      <DashboardViewInner organisationId={organisationId} dashboardId={dashboardId} startEditing={startEditing} />
    </RequireAnalytics>
  );
}

function DashboardViewInner({ organisationId, dashboardId, startEditing }: { organisationId: string; dashboardId: string; startEditing: boolean }) {
  const router = useRouter();
  const { can } = useWorkspace();
  const confirm = useConfirm();
  const loaded = useApiData<{ dashboard: Dashboard } & Partial<DateContext>>(`/api/analytics/dashboards/${dashboardId}`, { organisationId });
  const tables = useApiData<{ tables: TableInfo[] }>(can("bookkeeper") ? "/api/analytics/tables" : null, { organisationId });
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [editing, setEditing] = useState(startEditing && can("bookkeeper"));
  const [sharing, setSharing] = useState(false);
  const [theming, setTheming] = useState(false);
  // The format painter (#376): a tile's format, copied to paste on others.
  const [copied, setCopied] = useState<{ from: string; title: string; format: ChartFormat | undefined } | null>(null);
  const [editingTile, setEditingTile] = useState<Tile | "new" | "new-text" | null>(null);
  // Drag and drop (the arrows do the same from the keyboard).
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);
  // Tiles chosen for lining up and sizing (decision 752).
  const [chosenTiles, setChosenTiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The page shown (decision 753), kept in the address (?page=) so a link opens it.
  const search = useSearchParams();
  const [pageChoice, setPageChoice] = useState<string | null>(() => search.get("page"));
  // What the reader has drilled to, clicked and drilled through to (decisions 754-756); none of it is saved.
  const [drills, setDrills] = useState<Record<string, DrillState>>({});
  const [drillMode, setDrillMode] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<(Selection & { label: string; tileTitle: string }) | null>(null);
  const [through, setThrough] = useState<{ selection: Selection; label: string; from: string; to: string } | null>(null);
  // A bookmark's hidden tiles, the bookmark shown, and the pages seen before, for Back (decision 759).
  const [hidden, setHidden] = useState<string[]>([]);
  const [bookmarkShown, setBookmarkShown] = useState<string | null>(null);
  const [pageHistory, setPageHistory] = useState<string[]>([]);

  const dashboard = draft ?? loaded.data?.dashboard ?? null;
  const shown: Filters = filters ?? { from: dashboard?.settings.from ?? "", to: dashboard?.settings.to ?? "", preset: dashboard?.settings.preset ?? null, values: {} };
  const dates: DateContext = { today: loaded.data?.today ?? todayInBrowser(), financialYearEndMonth: loaded.data?.financialYearEndMonth ?? 3 };
  const canEdit = can("bookkeeper");
  /**
   * What a report's buttons do (#376 phase 2, decision 686). Only resetting
   * the filters exists so far; pages and bookmarks (phase 3) add their
   * actions here and in BUTTON_ACTIONS.
   */
  /** Back to the report as it opens: its dates and slicers, nothing clicked, drilled or drilled through (decision 756). */
  const resetView = () => {
    setFilters(null);
    setDrills({});
    setPicked(null);
    setThrough(null);
    setHidden([]);
    setBookmarkShown(null);
  };

  async function save(next: Dashboard) {
    setBusy(true);
    setError(null);
    try {
      const { dashboard: saved } = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, {
        method: "PATCH",
        body: { organisationId, name: next.name, description: next.description, settings: next.settings, tiles: next.tiles },
      });
      setDraft(saved);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!dashboard) return;
    const ok = await confirm(`Delete the ${dashboard.name} dashboard? The data it shows isn't touched.`, { title: "Delete dashboard?", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api(`/api/analytics/dashboards/${dashboardId}`, { method: "DELETE", query: { organisationId } });
      router.push("/analytics");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  /** Pastes the copied format on a tile (its key figure target stays its own). */
  function paste(tile: Tile) {
    if (!dashboard || !copied) return;
    const format = pasteFormat(copied.format, tile.format);
    const tiles = dashboard.tiles.map((entry) => {
      if (entry.id !== tile.id) return entry;
      const next = { ...entry };
      delete next.format;
      return format ? { ...next, format } : next;
    });
    void save({ ...dashboard, tiles });
  }

  /** Keeps (or with undefined, clears) the report's default look for a chart type. */
  function setVisualDefault(visual: DefaultableVisual, format: ChartFormat | undefined) {
    if (!dashboard) return;
    const defaults: VisualDefaults = { ...dashboard.settings.visualDefaults };
    if (format) defaults[visual] = format;
    else delete defaults[visual];
    const settings = { ...dashboard.settings };
    delete settings.visualDefaults;
    setDraft({ ...dashboard, settings: Object.keys(defaults).length ? { ...settings, visualDefaults: defaults } : settings });
  }

  function moveTile(index: number, to: number) {
    if (!dashboard) return;
    const tiles = moveTileTo(dashboard.tiles, index, to);
    if (tiles !== dashboard.tiles) void save({ ...dashboard, tiles });
  }

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!dashboard) return <p className={ui.muted}>Loading…</p>;
  const pages = dashboard.settings.pages;
  const page = openingPage(pages, pageChoice);
  const pageTiles = tilesOnPage(dashboard.tiles, pages, page.id);
  const look = pageStyle(page);
  const choosePage = (pageId: string, remember = true) => {
    if (remember && pageId !== page.id) setPageHistory((history) => [...history.slice(-19), page.id]);
    setPageChoice(pageId);
    setChosenTiles([]);
    const params = new URLSearchParams(window.location.search);
    params.set("page", pageId);
    window.history.replaceState(null, "", `?${params.toString()}`);
  };
  const setPages = (next: { pages: ReportPage[] | undefined; tiles: Tile[] }) => {
    const settings = { ...dashboard.settings };
    delete settings.pages;
    setDraft({ ...dashboard, settings: next.pages ? { ...settings, pages: next.pages } : settings, tiles: next.tiles });
  };
  // Clicks and drills (decisions 754-756), worked out the same way the server checks them.
  const grouping = (tile: Tile) => {
    if (!tile.query) return null;
    try {
      return drillView(tile.query, tile.drill, drills[tile.id], tile.title).groupBy;
    } catch {
      return tile.query.groupBy;
    }
  };
  const groupText = (tile: Tile, value: string | null) => {
    const level = grouping(tile);
    if (!level) return value ?? "(blank)";
    const shownValue = value === null ? "(blank)" : level.grain ? periodLabel(value, level.grain, dates.financialYearEndMonth) : value === "true" || value === "false" ? booleanText(value) : value;
    return `${fieldLabel(level.field)}: ${shownValue}`;
  };
  const pickedTile = picked ? pageTiles.find((tile) => tile.id === picked.tileId) : undefined;
  const selectionOnly = (selection: Selection): Selection => ({ tileId: selection.tileId, value: selection.value, ...(selection.drill ? { drill: selection.drill } : {}) });
  const pick = (tile: Tile, value: string | null) => {
    const levels = tile.drill?.levels.length ?? 1;
    const state = drills[tile.id] ?? TOP;
    if (drillMode[tile.id] && tile.drill && state.level < levels - 1) {
      setDrills({ ...drills, [tile.id]: drillDown(state, value, levels) });
      if (picked?.tileId === tile.id) setPicked(null);
      return;
    }
    if (picked?.tileId === tile.id && picked.value === value) return setPicked(null);
    setPicked({ tileId: tile.id, value, ...(drills[tile.id] ? { drill: drills[tile.id] } : {}), label: groupText(tile, value), tileTitle: tile.title });
  };
  const setDrill = (tile: Tile, next: DrillState) => {
    const copy = { ...drills };
    if (next.level === 0) delete copy[tile.id];
    else copy[tile.id] = next;
    setDrills(copy);
    if (picked?.tileId === tile.id) setPicked(null);
  };
  const interactionFor = (tile: Tile): TileInteraction => {
    const selections: Selection[] = [];
    let highlight: { value: string | null } | null = null;
    if (picked && pickedTile && picked.tileId !== tile.id) {
      const mode = interactionMode(pickedTile, tile.id);
      let level = null;
      try {
        level = selectionLevel(dashboard.tiles, picked).level;
      } catch {
        level = null;
      }
      const mine = grouping(tile);
      // Highlight works on a tile grouped the same way; on any other it filters (decision 754).
      if (mode === "highlight" && level && mine && mine.field === level.field && (mine.grain ?? null) === (level.grain ?? null)) highlight = { value: picked.value };
      else if (mode !== "none") selections.push(selectionOnly(picked));
    }
    if (picked?.tileId === tile.id) highlight = { value: picked.value };
    const drill = drills[tile.id];
    const throughList = through && through.to === page.id && through.selection.tileId !== tile.id ? [through.selection] : [];
    const view: TileView | undefined = drill || selections.length || throughList.length ? { ...(drill ? { drill } : {}), ...(selections.length ? { selections } : {}), ...(throughList.length ? { through: throughList } : {}) } : undefined;
    const canPick = !editing && DRILLABLE.includes(tile.visual) && Boolean(tile.query?.groupBy) && !tile.query?.breakdown;
    return { view, highlight, onPick: canPick ? (value) => pick(tile, value) : undefined };
  };
  const drillPages = (pages ?? []).filter((entry) => entry.drillThrough && entry.id !== page.id);
  const drillThrough = (target: ReportPage) => {
    if (!picked) return;
    setThrough({ selection: selectionOnly(picked), label: picked.label, from: page.id, to: target.id });
    setPicked(null);
    choosePage(target.id);
  };
  const viewChanged = Boolean(filters || picked || through || Object.keys(drills).length || hidden.length);
  /** Opens a bookmark: its page, dates, slicer choices and hidden tiles; nothing clicked or drilled (decision 759). */
  const openBookmark = (id: string) => {
    const bookmark = dashboard.settings.bookmarks?.find((entry) => entry.id === id);
    if (!bookmark) return;
    const state = bookmark.state;
    const range = state.preset ? presetRange(state.preset, dates.today, dates.financialYearEndMonth) : { from: state.from, to: state.to };
    setFilters({ from: range.from ?? "", to: range.to ?? "", preset: state.preset, values: state.values, ranges: state.ranges });
    setDrills({});
    setPicked(null);
    setThrough(null);
    setHidden(state.hidden ?? []);
    setBookmarkShown(bookmark.id);
    choosePage(state.page);
  };
  const goBack = () => {
    const previous = pageHistory[pageHistory.length - 1];
    if (!previous) return;
    setPageHistory(pageHistory.slice(0, -1));
    if (through) setThrough(null);
    choosePage(previous, false);
  };
  /** What a report's buttons do (decisions 686 and 759). */
  const runButtonAction = (action: ButtonAction, target?: string) => {
    if (action === "reset_filters") resetView();
    else if (action === "go_to_page" && target) choosePage(target);
    else if (action === "bookmark" && target) openBookmark(target);
    else if (action === "back") goBack();
  };

  /** A tile added or changed, on the page shown. */
  const placed = (tile: Tile): Tile => {
    // The editors build the tile afresh: a changed tile stays on its page, a new one goes on the page shown.
    const existing = dashboard.tiles.find((entry) => entry.id === tile.id);
    return withPage(tile, existing ? tilePage(existing, pages) : page.id, pages);
  };
  const textTile = editingTile === "new-text" ? "new" : editingTile && editingTile !== "new" && isItemVisual(editingTile.visual) ? editingTile : null;
  const chartTile = textTile || editingTile === "new-text" ? null : editingTile;
  // The report's theme (decision 668) is scoped to its tiles and the editor's preview.
  const theme = reportTheme(dashboard.settings.theme, dashboard.customTheme);
  const themeScope = `report-theme-${dashboard.id}`;
  const themeClass = isTohyee(theme) ? themeScope : `${themeScope} ${styles.themed}`;

  return (
    <ReportThemeStyle theme={theme} scope={themeScope}>
      <YearEndMonth.Provider value={dates.financialYearEndMonth}>
      <div className={styles.header}>
        <div>
          {editing ? (
            <div className={ui.grid3}>
              <Field label="Name">
                <input value={dashboard.name} maxLength={100} onChange={(event) => setDraft({ ...dashboard, name: event.target.value })} />
              </Field>
              <Field label="Description">
                <input value={dashboard.description ?? ""} maxLength={500} onChange={(event) => setDraft({ ...dashboard, description: event.target.value })} />
              </Field>
            </div>
          ) : (
            <>
              <h1 className={styles.title}>{dashboard.name}</h1>
              {dashboard.description ? <p className={ui.muted}>{dashboard.description}</p> : null}
            </>
          )}
        </div>
        <div className={ui.rowButtons}>
          {canEdit ? <Button variant="secondary" aria-expanded={sharing} onClick={() => setSharing(!sharing)}>Share</Button> : null}
          {canEdit && editing ? (
            <>
              <Button variant="secondary" onClick={() => setEditingTile("new")} disabled={busy || Boolean(editingTile) || !tables.data?.tables.length}>
                + Add chart
              </Button>
              <Button variant="secondary" onClick={() => setEditingTile("new-text")} disabled={busy || Boolean(editingTile)}>
                + Add text or item
              </Button>
              <Button variant="secondary" aria-expanded={theming} onClick={() => setTheming(!theming)} disabled={busy}>
                Theme: {theme.name}
              </Button>
              <Button
                onClick={async () => {
                  if (await save(dashboard)) {
                    setEditing(false);
                    setEditingTile(null);
                  }
                }}
                disabled={busy || Boolean(editingTile)}
              >
                {busy ? "Saving…" : "Save and view"}
              </Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy || Boolean(editingTile)}>
                Delete
              </Button>
            </>
          ) : canEdit ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing && tables.error ? <Notice tone="error">{tables.error}</Notice> : null}
      {editing && tables.data?.tables.length === 0 ? <Notice tone="info">Connect and load a <Link href="/analytics/sources">data source</Link> to start adding charts.</Notice> : null}

      <FilterBar
        organisationId={organisationId}
        dashboardId={dashboard.id}
        settings={dashboard.settings}
        filters={shown}
        onChange={(next) => {
          setFilters(next);
          setBookmarkShown(null);
        }}
        editing={editing}
        tables={tables.data?.tables ?? []}
        dates={dates}
        onSettings={(settings) => setDraft({ ...dashboard, settings })}
        pageId={page.id}
        pages={reportPages(pages)}
      />

      <PageTabs
        pages={pages}
        current={page.id}
        onChoose={choosePage}
        editing={editing}
        panelId={`report-page-${dashboard.id}`}
        onAdd={() => {
          const id = `p${Date.now().toString(36)}`;
          setPages(addPage(pages, dashboard.tiles, id));
          choosePage(id);
        }}
        onUpdate={(changed) => setPages({ pages: (pages?.length ? pages : [page]).map((entry) => (entry.id === changed.id ? changed : entry)), tiles: dashboard.tiles })}
        onMove={(pageId, by) => setPages(movePage(pages, dashboard.tiles, pageId, by))}
        filterEditor={(shownPage) => (
          <PageFilters
            organisationId={organisationId}
            tables={tables.data?.tables ?? []}
            filters={shownPage.filters ?? []}
            onChange={(next) => {
              const copy = { ...shownPage };
              delete copy.filters;
              const changed = next.length ? { ...copy, filters: next } : copy;
              setPages({ pages: (pages?.length ? pages : [page]).map((entry) => (entry.id === changed.id ? changed : entry)), tiles: dashboard.tiles });
            }}
          />
        )}
        onRemove={async (gone) => {
          const count = tilesOnPage(dashboard.tiles, pages, gone.id).length;
          const ok = await confirm(count ? `Remove the ${gone.name} page and its ${count} ${count === 1 ? "tile" : "tiles"}? Nothing is saved until you choose Save and view.` : `Remove the ${gone.name} page?`, { title: "Remove page?", confirmLabel: "Remove", danger: true });
          if (!ok) return;
          setPages(removePage(pages, dashboard.tiles, gone.id));
          setPageChoice(null);
        }}
      />

      <BookmarkBar
        bookmarks={dashboard.settings.bookmarks ?? []}
        shown={bookmarkShown}
        editing={editing}
        pageTiles={pageTiles}
        onOpen={openBookmark}
        current={(): BookmarkState => ({
          page: page.id,
          from: shown.preset ? null : shown.from || null,
          to: shown.preset ? null : shown.to || null,
          preset: shown.preset ?? null,
          values: Object.fromEntries(Object.entries(shown.values).filter(([, list]) => list.length)),
          ranges: shown.ranges ?? {},
          ...(hidden.length ? { hidden } : {}),
        })}
        onChange={(bookmarks) => {
          const settings = { ...dashboard.settings };
          delete settings.bookmarks;
          setDraft({ ...dashboard, settings: bookmarks.length ? { ...settings, bookmarks } : settings });
        }}
      />

      {sharing && canEdit ? <ShareCard organisationId={organisationId} dashboardId={dashboard.id} /> : null}

      {theming && editing && canEdit ? (
        <ThemePanel
          organisationId={organisationId}
          choice={dashboard.settings.theme}
          current={theme}
          onClose={() => setTheming(false)}
          onChoose={(choice, chosen) => {
            const settings = { ...dashboard.settings };
            delete settings.theme;
            setDraft({ ...dashboard, settings: choice ? { ...settings, theme: choice } : settings, customTheme: choice?.startsWith("custom:") ? chosen : null });
          }}
        />
      ) : null}

      {copied && editing ? (
        <Notice tone="info">
          Format copied from {copied.title}. Choose <strong>Paste format</strong> on the tiles to give them the same look.{" "}
          <Button size="small" variant="secondary" onClick={() => setCopied(null)}>Done pasting</Button>
        </Notice>
      ) : null}

      {canEdit && textTile ? (
        <ItemEditor
          key={textTile === "new" ? "new-text" : textTile.id}
          saving={busy}
          tile={textTile === "new" ? null : textTile}
          organisationId={organisationId}
          dashboardId={dashboard.id}
          tables={tables.data?.tables ?? []}
          filters={shown}
          onCancel={() => setEditingTile(null)}
          targets={{ pages: reportPages(pages).map((entry) => ({ id: entry.id, name: entry.name })), bookmarks: (dashboard.settings.bookmarks ?? []).map((entry) => ({ id: entry.id, name: entry.name })) }}
          onSave={async (given) => {
            const tile = placed(given);
            const exists = dashboard.tiles.some((entry) => entry.id === tile.id);
            const tiles = exists ? dashboard.tiles.map((entry) => (entry.id === tile.id ? tile : entry)) : [...dashboard.tiles, tile];
            if (await save({ ...dashboard, tiles })) setEditingTile(null);
          }}
        />
      ) : chartTile && canEdit ? (
        <TileEditor
          key={chartTile === "new" ? "new" : chartTile.id}
          saving={busy}
          organisationId={organisationId}
          tables={tables.data?.tables ?? []}
          tile={chartTile === "new" ? null : chartTile}
          filters={shown}
          defaults={dashboard.settings.visualDefaults}
          themeClass={themeClass}
          theme={theme}
          onSetDefault={setVisualDefault}
          others={pageTiles.filter((entry) => entry.id !== (chartTile === "new" ? "" : chartTile.id) && !isItemVisual(entry.visual)).map((entry) => ({ id: entry.id, title: entry.title }))}
          onCancel={() => setEditingTile(null)}
          onSave={async (given) => {
            const tile = placed(given);
            const exists = dashboard.tiles.some((entry) => entry.id === tile.id);
            const tiles = exists ? dashboard.tiles.map((entry) => (entry.id === tile.id ? tile : entry)) : [...dashboard.tiles, tile];
            if (await save({ ...dashboard, tiles })) setEditingTile(null);
          }}
        />
      ) : null}

      {!editing && (picked || (through && through.to === page.id) || viewChanged) ? (
        <div className={styles.trail} role="region" aria-label="What this page is filtered by">
          {through && through.to === page.id ? (
            <span className={styles.crumb}>
              Drilled through to {page.name}: <strong>{through.label}</strong>
              <Button size="small" variant="secondary" onClick={() => { const back = through.from; setThrough(null); choosePage(back); }}>← Back</Button>
            </span>
          ) : null}
          {picked ? (
            <span className={styles.crumb}>
              Filtered by <strong>{picked.label}</strong> <span className={ui.muted}>(chosen on {picked.tileTitle})</span>
              <Button size="small" variant="secondary" aria-label={`Clear ${picked.label}`} onClick={() => setPicked(null)}>Clear</Button>
              {drillPages.map((target) => (
                <Button key={target.id} size="small" variant="secondary" onClick={() => drillThrough(target)}>Drill through to {target.name}</Button>
              ))}
            </span>
          ) : null}
          {viewChanged ? <Button size="small" variant="secondary" onClick={resetView}>Reset to default</Button> : null}
        </div>
      ) : null}

      {editing && !editingTile ? (
        <ArrangeBar
          tiles={pageTiles}
          chosen={chosenTiles.filter((id) => pageTiles.some((tile) => tile.id === id))}
          onClear={() => setChosenTiles([])}
          onArrange={(tiles) => void save({ ...dashboard, tiles: [...tiles, ...dashboard.tiles.filter((tile) => !pageTiles.includes(tile))] })}
        />
      ) : null}

      {!editingTile && (pageTiles.length === 0 ? (
        <Empty>{canEdit ? editing ? `Start ${pages?.length ? "this page" : "your report"} with Add chart. Choose a source, a visual and the fields to show.` : "This page is empty. Choose Edit to add a chart." : "No tiles yet."}</Empty>
      ) : (
        <div id={`report-page-${dashboard.id}`} role={pages?.length ? "tabpanel" : undefined} aria-label={pages?.length ? page.name : undefined} style={look.style} className={`${styles.grid} ${themeClass} ${look.tinted ? styles.tintedPage : ""} ${look.style.background ? styles.colouredPage : ""}`}>
          {dashboard.tiles.map((tile, index) => {
            if (!pageTiles.includes(tile) || (!editing && hidden.includes(tile.id))) return null;
            // Moving goes past the tiles of other pages.
            const before = dashboard.tiles.lastIndexOf(pageTiles[pageTiles.indexOf(tile) - 1]);
            const after = dashboard.tiles.indexOf(pageTiles[pageTiles.indexOf(tile) + 1]);
            // Drawn with the report's default for its chart type under its own settings (#376).
            const shownTile = tileWithDefaults(tile, dashboard.settings.visualDefaults);
            const look = cardStyle(shownTile.format);
            return (
            <section
              key={tile.id}
              style={look.card}
              className={`${tileClass(shownTile)} ${dropAt === index && dragging !== null && dragging !== index ? styles.dropTarget : ""} ${dragging === index ? styles.dragging : ""} ${editing && chosenTiles.includes(tile.id) ? styles.chosenTile : ""}`}
              draggable={editing && !busy}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tile.id);
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                setDropAt(index);
              }}
              onDragLeave={() => setDropAt((current) => (current === index ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) moveTile(dragging, index);
                setDragging(null);
                setDropAt(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropAt(null);
              }}
            >
              <div className={styles.tileHeader}>
                <div>
                  <h2 className={shownTile.format?.card?.showTitle === false ? styles.visuallyHidden : styles.tileTitle} style={shownTile.format?.card?.showTitle === false ? undefined : look.title}>{tile.title}</h2>
                  {shownTile.format?.card?.subtitle ? <p className={styles.tileSubtitle} style={look.subtitle}>{shownTile.format.card.subtitle}</p> : null}
                  {tile.dates ? <p className={styles.tileDates}>{tileDatesText(tile.dates, formatDate)}</p> : null}
                </div>
                {editing ? (
                  <div className={styles.tileTools}>
                    <label className={`${ui.checkbox} ${styles.chooseTile}`}>
                      <input
                        type="checkbox"
                        aria-label={`Choose ${tile.title} to line up or size`}
                        checked={chosenTiles.includes(tile.id)}
                        onChange={(event) => setChosenTiles((current) => (event.target.checked ? [...current, tile.id] : current.filter((id) => id !== tile.id)))}
                      />{" "}
                      Select
                    </label>
                    <span className={styles.dragHandle} aria-hidden="true" title="Drag to move">⠿</span>
                    <Button size="small" variant="secondary" aria-label={`Move ${tile.title} earlier`} onClick={() => moveTile(index, before)} disabled={busy || before < 0}>
                      ↑
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      aria-label={`Move ${tile.title} later`}
                      onClick={() => moveTile(index, after)}
                      disabled={busy || after < 0}
                    >
                      ↓
                    </Button>
                    <Button size="small" variant="secondary" aria-label={`Edit ${tile.title}`} onClick={() => setEditingTile(tile)} disabled={busy}>
                      Edit
                    </Button>
                    {isItemVisual(tile.visual) ? null : copied && copied.from !== tile.id ? (
                      <Button size="small" variant="secondary" aria-label={`Paste format on ${tile.title}`} onClick={() => paste(tile)} disabled={busy}>
                        Paste format
                      </Button>
                    ) : (
                      <Button
                        size="small"
                        variant="secondary"
                        aria-label={`Copy the format of ${tile.title}`}
                        aria-pressed={copied?.from === tile.id}
                        onClick={() => setCopied(copied?.from === tile.id ? null : { from: tile.id, title: tile.title, format: tile.format })}
                        disabled={busy}
                      >
                        {copied?.from === tile.id ? "Copied" : "Copy format"}
                      </Button>
                    )}
                    <Button
                      size="small"
                      variant="secondary"
                      aria-label={`Duplicate ${tile.title}`}
                      onClick={() => void save({ ...dashboard, tiles: duplicateTile(dashboard.tiles, index, `t${Date.now().toString(36)}`) })}
                      disabled={busy || dashboard.tiles.length >= 40}
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="small"
                      variant="danger"
                      onClick={() => void save({ ...dashboard, tiles: dashboard.tiles.filter((entry) => entry.id !== tile.id) })}
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </div>
                ) : isItemVisual(tile.visual) ? null : (
                  // Only saved tiles can be pinned, so not while the dashboard is being changed.
                  <PinTileMenu organisationId={organisationId} dashboardId={dashboard.id} tileId={tile.id} />
                )}
              </div>
              {!editing ? (
                <>
                  {tile.drill ? (
                      <DrillTools
                        title={tile.title}
                        levels={tile.drill.levels.length}
                        state={drills[tile.id] ?? TOP}
                        on={drillMode[tile.id] === true}
                        path={(drills[tile.id]?.path ?? []).map((value, at) => {
                          const level = tile.drill!.levels[at];
                          return value === null ? "(blank)" : level.grain ? periodLabel(value, level.grain, dates.financialYearEndMonth) : value;
                        })}
                        current={levelName(grouping(tile))}
                        onToggle={() => setDrillMode({ ...drillMode, [tile.id]: !drillMode[tile.id] })}
                        onUp={() => setDrill(tile, drillUp(drills[tile.id] ?? TOP))}
                        onExpand={() => setDrill(tile, expandAll(drills[tile.id] ?? TOP, tile.drill!.levels.length))}
                      />
                    ) : null}
                </>
              ) : null}
              {editing ? (
                // Clicking a tile opens it for changing (the Edit button does the same from the keyboard).
                <div
                  className={styles.clickToEdit}
                  title="Click to edit"
                  onClick={(event) => {
                    if (busy || (event.target as HTMLElement).closest("button, a, input, select, textarea, summary")) return;
                    setEditingTile(tile);
                  }}
                >
                  <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={shownTile} filters={shown} onAction={runButtonAction} {...interactionFor(tile)} />
                </div>
              ) : (
                <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={shownTile} filters={shown} onAction={runButtonAction} {...interactionFor(tile)} />
              )}
            </section>
            );
          })}
        </div>
      ))}
      </YearEndMonth.Provider>
    </ReportThemeStyle>
  );
}

const GRAIN_NAMES: Record<string, string> = { fyear: "financial year", fquarter: "quarter", year: "year", quarter: "quarter", month: "month", week: "week", day: "day" };

/** A drill level as a reader sees it: "Account name", or "Posting date by quarter". */
function levelName(level: { field: string; grain?: string } | null): string {
  if (!level) return "";
  return level.grain ? `${fieldLabel(level.field)} by ${GRAIN_NAMES[level.grain] ?? level.grain}` : fieldLabel(level.field);
}

/** A tile's drill-down (decision 755): drill on click, up a level, the next level for all, and where it's drilled to. */
function DrillTools({ title, levels, state, on, path, current, onToggle, onUp, onExpand }: { title: string; levels: number; state: DrillState; on: boolean; path: string[]; current: string; onToggle: () => void; onUp: () => void; onExpand: () => void }) {
  return (
    <div className={styles.drillTools} role="group" aria-label={`Drill down ${title}`}>
      <Button size="small" variant="secondary" aria-pressed={on} title="When on, clicking a group shows the next level inside it" onClick={onToggle}>
        Drill down on click
      </Button>
      <Button size="small" variant="secondary" disabled={state.level === 0} aria-label={`Up a level on ${title}`} onClick={onUp}>↑ Up</Button>
      <Button size="small" variant="secondary" disabled={state.level >= levels - 1} title="The next level for every group" aria-label={`Next level for all on ${title}`} onClick={onExpand}>Next level for all</Button>
      <span className={styles.drillPath} aria-live="polite">
        {state.level === 0 ? current : `${state.all && path.length < state.level ? "All" : path.join(" › ")} › ${current}`}
      </span>
    </div>
  );
}

const WIDTH_CLASSES: Record<TileWidth, string> = {
  quarter: styles.quarter,
  third: styles.third,
  half: styles.half,
  "two-thirds": styles.twoThirds,
  full: styles.full,
};

function tileClass(tile: Tile): string {
  const card = tile.format?.card;
  return [
    styles.tile,
    WIDTH_CLASSES[tile.width] ?? styles.half,
    tile.visual === "text" ? styles.textTile : "",
    card?.background === "tinted" ? styles.tinted : card?.background === "none" ? styles.bare : "",
    card?.border === false ? styles.borderless : "",
  ].filter(Boolean).join(" ");
}

type ReportViewer = { userId: string; email: string; displayName: string; isActive: boolean };

/** Sharing a dashboard with report viewers, e.g. clients (decision 360). They sign in and see only what's shared. */
function ShareCard({ organisationId, dashboardId }: { organisationId: string; dashboardId: string }) {
  const shares = useApiData<{ shares: string[]; reportViewers: ReportViewer[] }>(`/api/analytics/dashboards/${dashboardId}/shares`, { organisationId });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const current = chosen ?? shares.data?.shares ?? [];
  const people = shares.data?.reportViewers ?? [];

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ shares: string[] }>(`/api/analytics/dashboards/${dashboardId}/shares`, {
        method: "PUT",
        body: { organisationId, userIds: current },
      });
      setChosen(result.shares);
      shares.reload();
      setMessage({ tone: "success", text: result.shares.length ? `Shared with ${result.shares.length} ${result.shares.length === 1 ? "person" : "people"}.` : "Not shared with anyone." });
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Share with clients"
      description="Report viewers sign in like anyone else and see only the dashboards shared with them, nothing of the books. Add someone as a Report viewer under Accounting › Members first."
    >
      {shares.error ? <Notice tone="error">{shares.error}</Notice> : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!shares.data ? (
        <p className={ui.muted}>Loading…</p>
      ) : people.length === 0 ? (
        <Empty>This organisation has no report viewers yet.</Empty>
      ) : (
        <div className={styles.shareList}>
          {people.map((person) => (
            <label key={person.userId} className={ui.checkbox}>
              <input
                type="checkbox"
                checked={current.includes(person.userId)}
                onChange={(event) =>
                  setChosen(event.target.checked ? [...current, person.userId] : current.filter((entry) => entry !== person.userId))
                }
              />{" "}
              {person.displayName} <span className={ui.muted}>{person.email}{person.isActive ? "" : " · can't sign in"}</span>
            </label>
          ))}
          <div>
            <Button size="small" onClick={() => void save()} disabled={busy || chosen === null}>
              {busy ? "Saving…" : "Save sharing"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Bookmarks (decision 759): open one to see its page, dates, slicer
 * choices and hidden tiles. In edit mode, add one from the view shown,
 * update, rename or remove it, and choose tiles it hides.
 */
function BookmarkBar({ bookmarks, shown, editing, pageTiles, onOpen, current, onChange }: { bookmarks: Bookmark[]; shown: string | null; editing: boolean; pageTiles: Tile[]; onOpen: (id: string) => void; current: () => BookmarkState; onChange: (bookmarks: Bookmark[]) => void }) {
  if (!editing && !bookmarks.length) return null;
  const update = (id: string, patch: Partial<Bookmark>) => onChange(bookmarks.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  return (
    <div className={styles.bookmarks}>
      {bookmarks.length ? (
        <div className={styles.bookmarkList} role="group" aria-label="Bookmarks">
          <span className={styles.bookmarkLabel}>Bookmarks</span>
          {bookmarks.map((bookmark) => (
            <Button key={bookmark.id} size="small" variant="secondary" aria-pressed={shown === bookmark.id} onClick={() => onOpen(bookmark.id)}>{bookmark.name}</Button>
          ))}
        </div>
      ) : null}
      {editing ? (
        <details className={styles.slicerSettings}>
          <summary>Bookmark settings</summary>
          <div className={styles.slicerSettingsBody}>
            <p className={ui.muted}>A bookmark keeps the page shown, its dates and slicer choices, and any tiles you hide in it. Choose a bookmark above to see it.</p>
            {bookmarks.map((bookmark) => (
              <fieldset key={bookmark.id} className={styles.slicerPages}>
                <legend>{bookmark.name}</legend>
                <Field label="Name"><input value={bookmark.name} maxLength={60} onChange={(event) => update(bookmark.id, { name: event.target.value })} /></Field>
                {bookmark.state.page === current().page && pageTiles.length ? (
                  <div className={styles.hiddenList}>
                    <span className={styles.bookmarkLabel}>Hidden in this bookmark</span>
                    {pageTiles.map((tile) => (
                      <label key={tile.id} className={ui.checkbox}>
                        <input type="checkbox" checked={bookmark.state.hidden?.includes(tile.id) ?? false} onChange={(event) => {
                          const list = event.target.checked ? [...(bookmark.state.hidden ?? []), tile.id] : (bookmark.state.hidden ?? []).filter((id) => id !== tile.id);
                          const state = { ...bookmark.state };
                          delete state.hidden;
                          update(bookmark.id, { state: list.length ? { ...state, hidden: list } : state });
                        }} /> {tile.title}
                      </label>
                    ))}
                  </div>
                ) : <p className={ui.muted}>Go to its page to choose the tiles it hides.</p>}
                <div className={ui.rowButtons}>
                  <Button size="small" variant="secondary" onClick={() => update(bookmark.id, { state: { ...current(), ...(bookmark.state.hidden && bookmark.state.page === current().page ? { hidden: bookmark.state.hidden } : {}) } })}>Update to the view shown</Button>
                  <Button size="small" variant="danger" onClick={() => onChange(bookmarks.filter((entry) => entry.id !== bookmark.id))}>Remove</Button>
                </div>
              </fieldset>
            ))}
            <div>
              <Button size="small" variant="secondary" disabled={bookmarks.length >= 20} onClick={() => onChange([...bookmarks, { id: `b${Date.now().toString(36)}`, name: bookmarkName(bookmarks), state: current() }])}>+ Add a bookmark of the view shown</Button>
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** A page's own filters (decision 758): one data source's tests, on every tile of the page whose table has the column. */
function PageFilters({ organisationId, tables, filters, onChange }: { organisationId: string; tables: TableInfo[]; filters: PageFilter[]; onChange: (filters: PageFilter[]) => void }) {
  const [table, setTable] = useState(filters[0]?.table ?? "");
  const columns = tables.find((entry) => entry.name === table)?.columns ?? [];
  // Rows being typed stay here; only complete ones go on the page.
  const [draft, setDraft] = useState<Filter[]>(filters.map((entry) => entry.filter));
  return (
    <fieldset className={styles.slicerPages}>
      <legend>Filters on this page</legend>
      <p className={ui.muted}>Every tile on this page whose data has the column shows only these rows.</p>
      <Field label="Data source">
        <select value={table} onChange={(event) => { setTable(event.target.value); setDraft([]); onChange([]); }}>
          <option value="">Choose a data source</option>
          {tables.map((entry) => <option key={entry.name} value={entry.name}>{tableLabel(entry.name)}</option>)}
        </select>
      </Field>
      {table ? (
        <TileFilters
          organisationId={organisationId}
          table={table}
          columns={columns}
          filters={draft}
          onChange={(next) => {
            setDraft(next.slice(0, 6));
            onChange(next.filter(filterComplete).slice(0, 6).map((filter) => {
              const copy = { ...filter };
              delete copy.join;
              return { table, filter: copy };
            }));
          }}
        />
      ) : null}
    </fieldset>
  );
}

/** A slicer's settings in edit mode (decision 757): style, name, second level, pages and size. */
function SlicerSettings({ slicer, type, columns, pages, onChange, onRemove }: { slicer: Slicer; type: string; columns: ColumnInfo[]; pages: ReportPage[]; onChange: (slicer: Slicer) => void; onRemove: () => void }) {
  const set = (patch: Partial<Slicer>) => {
    const next: Slicer = { ...slicer, ...patch };
    for (const key of Object.keys(patch) as Array<keyof Slicer>) if (patch[key] === undefined) delete next[key];
    onChange(next);
  };
  return (
    <details className={styles.slicerSettings}>
      <summary>Slicer settings</summary>
      <div className={styles.slicerSettingsBody}>
        <Field label="Name">
          <input value={slicer.label} maxLength={60} onChange={(event) => set({ label: event.target.value })} />
        </Field>
        <Field label="Style">
          <select value={slicer.style ?? "list"} onChange={(event) => {
            const style = event.target.value as SlicerStyle;
            const child = style === "hierarchy" ? columns.find((column) => column.name !== slicer.field && !isNumber(column.type) && !isDate(column.type) && column.type !== "BOOLEAN")?.name : undefined;
            set({ style: style === "list" ? undefined : style, child });
          }}>
            {stylesFor(type).map((style) => <option key={style} value={style}>{SLICER_STYLE_LABELS[style]}</option>)}
          </select>
        </Field>
        {slicer.style === "hierarchy" ? (
          <Field label="Second level">
            <select value={slicer.child ?? ""} onChange={(event) => set({ child: event.target.value })}>
              {columnOptions(columns.filter((column) => column.name !== slicer.field && !isNumber(column.type) && !isDate(column.type) && column.type !== "BOOLEAN"))}
            </select>
          </Field>
        ) : null}
        <Field label="Size">
          <select value={`${slicer.look?.size ?? ""}|${slicer.look?.width ?? ""}`} onChange={(event) => {
            const [size, width] = event.target.value.split("|");
            set({ look: size || width ? { ...(size ? { size: size as "small" | "large" } : {}), ...(width ? { width: "wide" as const } : {}) } : undefined });
          }}>
            <option value="|">Normal</option>
            <option value="small|">Small</option>
            <option value="large|">Large</option>
            <option value="|wide">Wide</option>
            <option value="large|wide">Large and wide</option>
          </select>
        </Field>
        {pages.length > 1 ? (
          <fieldset className={styles.slicerPages}>
            <legend>Shows and filters on</legend>
            <label className={ui.checkbox}>
              <input type="checkbox" checked={!slicer.pages} onChange={(event) => set({ pages: event.target.checked ? undefined : pages.map((page) => page.id) })} /> Every page (in step)
            </label>
            {slicer.pages ? pages.map((page) => (
              <label key={page.id} className={ui.checkbox}>
                <input type="checkbox" checked={slicer.pages!.includes(page.id)} onChange={(event) => {
                  const chosen = event.target.checked ? [...slicer.pages!, page.id] : slicer.pages!.filter((id) => id !== page.id);
                  set({ pages: chosen.length === pages.length ? undefined : chosen.length ? chosen : slicer.pages });
                }} /> {page.name}
              </label>
            )) : null}
          </fieldset>
        ) : null}
        <div>
          <Button size="small" variant="danger" onClick={onRemove}>Remove slicer</Button>
        </div>
      </div>
    </details>
  );
}

function FilterBar({
  organisationId,
  settings,
  filters,
  onChange,
  editing,
  tables,
  dates,
  onSettings,
  dashboardId,
  pageId,
  pages,
}: {
  organisationId: string;
  dashboardId: string;
  /** The page shown: only its slicers show (decision 757). */
  pageId: string;
  pages: ReportPage[];
  settings: DashboardSettings;
  filters: Filters;
  onChange: (filters: Filters) => void;
  editing: boolean;
  tables: TableInfo[];
  dates: DateContext;
  onSettings: (settings: DashboardSettings) => void;
}) {
  const [newSlicer, setNewSlicer] = useState("");
  // Any column: text and Yes/No as lists, numbers and dates as ranges (decisions 577, 757), grouped by where they come from.
  const slicerTables = tables.filter((table) => table.columns.length > 0).map((table) => ({ table, columns: table.columns }));
  // The preset chosen, or the one these dates happen to be today, so the list shows where they came from.
  const preset = filters.preset ?? matchingPreset(filters, dates.today, dates.financialYearEndMonth);
  const presetName = DATE_PRESETS.find((entry) => entry.value === filters.preset)?.label;
  return (
    <div className={styles.filterBar}>
      <Field label="Dates">
        <select
          value={preset ?? ""}
          onChange={(event) => {
            const chosen = event.target.value;
            if (!isDatePreset(chosen)) return onChange({ ...filters, preset: null });
            const range = presetRange(chosen, dates.today, dates.financialYearEndMonth);
            onChange({ ...filters, from: range.from ?? "", to: range.to ?? "", preset: chosen });
          }}
        >
          <option value="">Custom</option>
          {DATE_PRESETS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="From">
        <DateInput value={filters.from} onChange={(event) => onChange({ ...filters, from: event.target.value, preset: null })} />
      </Field>
      <Field label="To">
        <DateInput value={filters.to} onChange={(event) => onChange({ ...filters, to: event.target.value, preset: null })} />
      </Field>
      {settings.slicers.map((slicer, index) => (editing || slicerOnPage(slicer, pageId) ? (
        <SlicerControl
          key={`${slicer.table}.${slicer.field}`}
          organisationId={organisationId}
          dashboardId={dashboardId}
          slicer={slicer}
          chosen={filters.values[slicer.field] ?? []}
          childChosen={slicer.child ? filters.values[slicer.child] ?? [] : undefined}
          range={filters.ranges?.[slicer.field]}
          onChange={(values) => onChange({ ...filters, values: { ...filters.values, [slicer.field]: values } })}
          onChildChange={slicer.child ? (values) => onChange({ ...filters, values: { ...filters.values, [slicer.child!]: values } }) : undefined}
          onRange={(range) => {
            const ranges = { ...filters.ranges };
            if (range) ranges[slicer.field] = range;
            else delete ranges[slicer.field];
            onChange({ ...filters, ranges });
          }}
          settings={editing ? (
            <SlicerSettings
              slicer={slicer}
              type={tables.find((table) => table.name === slicer.table)?.columns.find((column) => column.name === slicer.field)?.type ?? "VARCHAR"}
              columns={tables.find((table) => table.name === slicer.table)?.columns ?? []}
              pages={pages}
              onChange={(next) => onSettings({ ...settings, slicers: settings.slicers.map((entry, at) => (at === index ? next : entry)) })}
              onRemove={() => onSettings({ ...settings, slicers: settings.slicers.filter((entry) => entry !== slicer) })}
            />
          ) : undefined}
        />
      ) : null))}
      {editing ? (
        <>
          <Field label="Add a slicer">
            <select value={newSlicer} onChange={(event) => setNewSlicer(event.target.value)}>
              <option value="">Choose a column</option>
              {slicerTables.map(({ table, columns }) => (
                <optgroup key={table.name} label={tableLabel(table.name)}>
                  {columns.map((column) => (
                    <option key={column.name} value={`${table.name}.${column.name}`} title={`${table.name}.${column.name}`}>
                      {tableLabel(table.name)} › {fieldLabel(column.name)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Button
            size="small"
            variant="secondary"
            disabled={!newSlicer}
            onClick={() => {
              const [table, field] = newSlicer.split(".");
              const type = tables.find((entry) => entry.name === table)?.columns.find((column) => column.name === field)?.type ?? "VARCHAR";
              const style = stylesFor(type)[0];
              onSettings({ ...settings, slicers: [...settings.slicers, { table, field, label: fieldLabel(field), ...(style !== "list" ? { style } : {}) }] });
              setNewSlicer("");
            }}
          >
            Add slicer
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => onSettings({ ...settings, from: filters.from || null, to: filters.to || null, preset: filters.preset ?? null })}
            title={presetName ? `Open the dashboard with ${presetName.toLowerCase()}, moving on with the calendar` : "Open the dashboard with these dates"}
          >
            Keep these dates
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** A tile's answer: its saved question (`saved`, all a report viewer can run) or a question being built (`query`). */
/** What a reader has done to a tile (decisions 754-756): its view for the server, a click handler and the group to highlight. */
type TileInteraction = { view?: TileView; onPick?: (value: string | null) => void; highlight?: { value: string | null } | null };

function TileBody(props: { organisationId: string; dashboardId: string; tile: Tile; filters: Filters; onAction?: (action: ButtonAction, target?: string) => void } & TileInteraction) {
  const { tile } = props;
  const height = CHART_HEIGHTS[tile.height ?? "small"];
  if (tile.visual === "text") return <TextItemView organisationId={props.organisationId} dashboardId={props.dashboardId} tile={tile} filters={props.filters} />;
  if (tile.visual === "image" && tile.image) return <ImageItemView organisationId={props.organisationId} dashboardId={props.dashboardId} image={tile.image} height={height} />;
  if (tile.visual === "shape" && tile.shape) return <ShapeItemView shape={tile.shape} height={height} />;
  if (tile.visual === "button" && tile.button) return <ButtonItemView button={tile.button} onAction={props.onAction} />;
  return <QueryTileBody {...props} />;
}

function QueryTileBody({ organisationId, dashboardId, tile, filters, view, onPick, highlight }: { organisationId: string; dashboardId: string; tile: Tile; filters: Filters } & TileInteraction) {
  const state = useTileResult(organisationId, tile.query, filters, { dashboardId, tileId: tile.id }, view ? { view } : undefined);
  const { current } = useWorkspace();
  const [opened, setDrill] = useState<{ title: string; result: PivotDrillResult; filtersKey: string } | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  // Rows opened under other dates or slicers no longer match the tile, so they're put away.
  const filtersKey = JSON.stringify([filters, view]);
  const drill = opened?.filtersKey === filtersKey ? opened : null;
  if (!state) return <p className={ui.muted}>Working it out…</p>;
  if (state.error) return <Notice tone="error">{state.error}</Notice>;
  const openDrill = async (selection: PivotDrillSelection, title: string) => {
    setDrill(null);
    setDrillError(null);
    try {
      const result = await api<PivotDrillResult>("/api/analytics/query", {
        method: "POST",
        body: {
          organisationId,
          dashboardId,
          tileId: tile.id,
          filters: { from: filters.from || null, to: filters.to || null, values: filters.values },
          drill: selection,
          ...(view ? { view } : {}),
        },
      });
      setDrill({ title, result, filtersKey });
    } catch (error) {
      setDrillError(errorMessage(error));
    }
  };
  return (
    <>
      {drillError ? <Notice tone="error">{drillError}</Notice> : null}
      <TileResult
        tile={tile}
        result={state.result!}
        onDrill={tile.visual === "pivot" ? (selection, title) => void openDrill(selection, title) : undefined}
        onPick={onPick}
        highlight={highlight}
        exportFor={{ organisationId, organisationName: current?.id === organisationId ? current.displayName : "Organisation", filters }}
      />
      {drill ? (
        <div className={styles.drill}>
          <div className={styles.drillHeader}>
            <h3>{drill.title}</h3>
            <Button size="small" variant="secondary" onClick={() => setDrill(null)}>Close rows</Button>
          </div>
          {drill.result.rows.length === 0 ? (
            <Empty>No matching rows.</Empty>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table} aria-label={drill.title}>
                <thead>
                  <tr>{drill.result.columns.map((column) => <th key={column.key} scope="col" className={column.role === "measure" ? ui.num : undefined}>{fieldLabel(column.label)}</th>)}</tr>
                </thead>
                <tbody>
                  {drill.result.rows.map((row, index) => (
                    <tr key={index}>
                      {drill.result.columns.map((column) => (
                        <td key={column.key} className={column.role === "measure" ? ui.num : undefined}>{showValue(row[column.key], column)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {drill.result.truncated ? <p className={ui.muted}>Showing the first 500 rows.</p> : null}
        </div>
      ) : null}
    </>
  );
}

/** The organisation's balance month, for naming financial years and quarters (decision 755). */
const YearEndMonth = createContext(3);

/** Periods named for people: "FY2027", "Q3 2026" (months and days keep the chart's own names). */
const NAMED_GRAINS = new Set(["year", "quarter", "fyear", "fquarter", "week"]);

function TileResult({
  tile,
  result,
  onDrill,
  exportFor,
  onPick,
  highlight,
}: {
  tile: Pick<Tile, "title" | "visual" | "format" | "height"> & { query?: TileQuery | null };
  result: QueryResult;
  onDrill?: (selection: PivotDrillSelection, title: string) => void;
  exportFor?: PivotExportFor;
  /** A group clicked (its value as the server gave it), to filter other tiles or drill down (decision 754). */
  onPick?: (value: string | null) => void;
  /** The group to show at full strength, the rest faded. */
  highlight?: { value: string | null } | null;
}) {
  const measures = result.columns.filter((column) => column.role === "measure");
  const spec = useMemo(() => tileChartSpec(tile, measures), [tile, measures]);
  const yearEndMonth = useContext(YearEndMonth);

  if (tile.visual === "pivot") {
    return result.pivot ? <PivotTable title={tile.title} pivot={result.pivot} onDrill={onDrill} exportFor={exportFor} format={tile.format} /> : <Notice tone="error">This pivot table needs to be saved again.</Notice>;
  }
  if (result.rows.length === 0) return <Empty>Nothing matches.</Empty>;
  // Yes/No groups are named Yes and No on the chart too (decision 577).
  const yesNo = result.columns.some((column) => column.key === "category" && column.format === "boolean");
  const grain = result.columns.find((column) => column.key === "category")?.grain;
  const named = yesNo
    ? result.rows.map((row) => ({ ...row, category: row.category === null ? null : booleanText(row.category) }))
    : grain && NAMED_GRAINS.has(grain)
      ? result.rows.map((row) => ({ ...row, category: row.category === null ? null : periodLabel(row.category, grain, yearEndMonth) }))
      : result.rows;
  const rows = tile.visual === "pie" || tile.visual === "donut" ? foldSlices(named, measures[0]?.key ?? "m0") : named;
  // Each group as drawn, back to its value as the server gave it (for clicks), and which to highlight.
  const rawOf = new Map(named.map((row, index) => [String(row.category), result.rows[index].category ?? null]));
  const pickRow = onPick
    ? (index: number) => {
        const label = rows[index]?.category;
        if (label !== undefined && rawOf.has(String(label))) onPick(rawOf.get(String(label)) ?? null);
      }
    : undefined;
  const highlighted = highlight ? rows.map((row, index) => (rawOf.get(String(row.category)) === highlight.value ? index : -1)).filter((index) => index >= 0) : null;
  if (tile.visual === "kpi") return <KeyFigureView result={result} format={tile.format} />;
  if (!spec) {
    // Table styles and conditional formatting (#376), by each value's position among the tile's values.
    const look = tableLook(tile.format?.table);
    const ranges = measures.map((column) => columnRange(result.rows.map((row) => row[column.key])));
    const aggregates = (tile.query?.measures ?? []).flatMap((measure) => (measure.compare ? [measure.aggregate, measure.aggregate] : [measure.aggregate]));
    const totals = tile.format?.table?.totals ? tableTotals(result.columns, result.rows, aggregates) : null;
    return (
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${look.className}`} style={look.style}>
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column.key} className={column.role === "measure" ? ui.num : undefined}>
                  {column.role === "category" ? fieldLabel(column.label) : heading(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={index}>
                {result.columns.map((column) => {
                  const valueIndex = measures.indexOf(column);
                  return valueIndex < 0 ? (
                    <td key={column.key} className={highlight && column.key === "category" && row.category !== highlight.value ? styles.fadedCell : undefined}>
                      {onPick && column.key === "category" ? (
                        <button type="button" className={styles.groupButton} aria-pressed={highlight ? row.category === highlight.value : undefined} onClick={() => onPick(row.category ?? null)}>
                          {grain && NAMED_GRAINS.has(grain) && row.category ? periodLabel(row.category, grain, yearEndMonth) : showValue(row[column.key], column)}
                        </button>
                      ) : grain && NAMED_GRAINS.has(grain) && column.key === "category" && row.category ? periodLabel(row.category, grain, yearEndMonth) : showValue(row[column.key], column)}
                    </td>
                  ) : (
                    <FormattedCell key={column.key} className={ui.num} format={tile.format} valueIndex={valueIndex} value={row[column.key] ?? null} range={ranges[valueIndex]} field={row.category ?? null}>
                      {showValue(row[column.key], column)}
                    </FormattedCell>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot>
              <tr className={totalRowClass(tile.format?.table, styles.pivotTotal)}>
                {result.columns.map((column, index) => (
                  <th key={column.key} scope={index === 0 ? "row" : undefined} className={column.role === "measure" ? ui.num : undefined}>
                    {index === 0 ? (result.truncated ? "Total of the rows shown" : "Total") : totals[column.key] === null ? "" : showValue(totals[column.key], column)}
                  </th>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
        {result.truncated ? <p className={ui.muted}>Showing the first 5,000 rows.</p> : null}
      </div>
    );
  }
  if (tile.query?.breakdown && (tile.visual === "column" || tile.visual === "bar" || tile.visual === "line")) {
    // Small multiples (#376 phase 2): one small chart for each value of the second grouping.
    return <SmallMultiplesView spec={spec} rows={rows} additive={additiveValues(tile.query.measures)} height={MULTIPLE_HEIGHTS[tile.height ?? "medium"]} />;
  }
  if (tile.visual === "filledmap" || tile.visual === "pointmap") {
    // Groups that can't go on the map are named under it (the hidden data table still has every row).
    const note = mapNote(tile.visual, rows, chartGroupNames(rows.map((row) => row.category)), measures.map((column) => column.key), tile.format?.map?.areas);
    return (
      <>
        <Chart spec={spec} rows={rows} height={CHART_HEIGHTS[tile.height ?? "medium"]} onPick={pickRow} highlight={highlighted} />
        {note ? <p className={styles.mapNote}>{note}</p> : null}
        <p className={styles.mapNote}>{MAP_ATTRIBUTION}</p>
      </>
    );
  }
  // A calendar heat map is as tall as the years it shows (up to three).
  const height = tile.visual === "calendar"
    ? Math.max(CHART_HEIGHTS[tile.height ?? "medium"], calendarHeight(calendarYears(rows.map((row) => String(row.category ?? ""))).length))
    : CHART_HEIGHTS[tile.height ?? "medium"];
  return (
    <>
      {pickRow ? <GroupChooser rows={rows} chosen={highlighted?.length === 1 ? highlighted[0] : null} onChoose={pickRow} /> : null}
      <Chart spec={spec} rows={rows} height={height} onPick={pickRow} highlight={highlighted} />
    </>
  );
}

/** Choosing a chart's group from the keyboard, as a click on it does (decision 754). */
function GroupChooser({ rows, chosen, onChoose }: { rows: QueryResult["rows"]; chosen: number | null; onChoose: (index: number) => void }) {
  return (
    <label className={styles.groupChooser}>
      <span className={styles.visuallyHidden}>Choose a group to filter by or drill into</span>
      <select value={chosen ?? ""} onChange={(event) => event.target.value !== "" && onChoose(Number(event.target.value))}>
        <option value="">Choose a group…</option>
        {rows.map((row, index) => (row.category === "Other" ? null : <option key={index} value={index}>{String(row.category ?? "(blank)")}</option>))}
      </select>
    </label>
  );
}

function pivotRowLabel(row: PivotRow, index: number, field: ResultColumn): string {
  if (row.kind === "grand_total" && index === 0) return "Grand total";
  if (row.kind === "subtotal" && index === row.depth) return "Subtotal";
  if (index >= row.depth && row.kind !== "detail") return "";
  return row.dimensions[index] === null ? "(blank)" : showValue(row.dimensions[index], field);
}

function pivotColumnLabel(column: PivotColumn, pivot: PivotData): string {
  if (column.total) return "Grand total";
  if (!pivot.columnField) return column.measure.label;
  if (column.path) return columnPathText(column, (level, value) => pivotValueLabel(pivot, level, value, false));
  return column.pivotValue === null ? "(blank)" : showValue(column.pivotValue, pivot.columnField);
}

/** A column field's value as shown, with its field's name in front for headings. */
function pivotValueLabel(pivot: PivotData, level: number, value: string | null, named: boolean): string {
  const field = pivot.columnFields?.[level] ?? pivot.columnField!;
  const text = value === null ? "(blank)" : showValue(value, field);
  return named ? `${fieldLabel(field.label)}: ${text}` : text;
}

/** The pivot as a report table for the existing CSV/Excel export (`/api/reports/export`), exact values kept as text. */
export function pivotExportTable(pivot: PivotData): ReportExportTable {
  const columns = [
    ...pivot.rowFields.map((field) => fieldLabel(field.label)),
    ...pivot.columns.map((column) =>
      [
        column.total
          ? "Grand total"
          : column.path
            ? columnPathText(column, (level, value) => pivotValueLabel(pivot, level, value, true))
            : pivot.columnField
              ? `${fieldLabel(pivot.columnField.label)}: ${pivotColumnLabel(column, pivot)}`
              : "",
        column.measure.label,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ];
  const rows = pivot.rows.map((row) => ({
    kind: row.kind === "detail" ? undefined : ("total" as const),
    cells: [
      ...pivot.rowFields.map((field, index) => ({ text: pivotRowLabel(row, index, field) })),
      ...pivot.columns.map((column) => {
        const value = row.cells[column.key] ?? null;
        const text = showValue(value, column.measure);
        return value !== null && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? { text, value, numeric: true } : { text };
      }),
    ],
  }));
  return { columns, rows };
}

export function PivotTable({
  title,
  pivot,
  onDrill,
  exportFor,
  format,
}: {
  title: string;
  pivot: PivotData;
  /** Table style and conditional formatting (#376). */
  format?: ChartFormat;
  onDrill?: (selection: PivotDrillSelection, title: string) => void;
  /** Where the export comes from; without it (e.g. a preview) there's no export. */
  exportFor?: PivotExportFor;
}) {
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const download = async (format: "csv" | "xlsx") => {
    if (!exportFor) return;
    setExportError(null);
    setExporting(true);
    try {
      const { from, to, values } = exportFor.filters;
      const data: ReportExportData = {
        report: "analytics-pivot",
        organisationName: exportFor.organisationName,
        title,
        period: from || to ? `${from ? formatDate(from) : "Start"} to ${to ? formatDate(to) : "today"}` : "All dates",
        basis: null,
        filters: Object.entries(values)
          .filter(([, chosen]) => chosen.length > 0)
          .map(([field, chosen]) => `${fieldLabel(field)}: ${chosen.join(", ")}`)
          .slice(0, 30),
        producedAt: new Date().toISOString(),
        tables: [pivotExportTable(pivot)],
      };
      const blob = await apiDownload("/api/reports/export", { organisationId: exportFor.organisationId, format, data });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title.trim().replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "") || "pivot"}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setExporting(false);
    }
  };
  const click = (row: PivotRow, column: PivotColumn) => {
    if (!onDrill) return;
    const rowValues = row.dimensions.slice(0, row.depth).map((value) => value === null ? "(blank)" : value);
    const columnValue = column.total ? "Grand total" : pivot.columnField ? pivotColumnLabel(column, pivot) : "";
    const drillTitle = [rowValues.join(" · "), columnValue, column.measure.label].filter(Boolean).join(" · ") || "Grand total";
    onDrill(
      { depth: row.depth, dimensions: row.dimensions, pivotValue: column.pivotValue, total: column.total, ...(column.path ? { pivotPath: column.path } : {}) },
      `Rows · ${drillTitle}`,
    );
  };
  const look = tableLook(format?.table);
  // A value's position among the tile's values, for its conditional formatting.
  const measureKeys = [...new Set(pivot.columns.map((column) => column.measure.key))];
  const detailRows = pivot.rows.filter((row) => row.kind === "detail");
  const ranges = new Map(pivot.columns.map((column) => [column.key, columnRange(detailRows.map((row) => row.cells[column.key] ?? null))]));
  // Matrix layout (#376 phase 2): stepped rows, and groups that open and close.
  const levels = pivot.rowFields.length;
  const stepped = format?.table?.layout === "stepped" && levels > 0;
  const offLevels = new Set(format?.table?.subtotalsOff ?? []);
  const ordered = stepped ? steppedRows(pivot.rows.filter((row) => row.kind !== "grand_total" || format?.table?.totals !== false), levels) : visiblePivotRows(pivot.rows, format?.table);
  const groupsKey = JSON.stringify([pivot.rows.map((row) => row.key), format?.table?.expandTo]);
  const [collapsedState, setCollapsed] = useState<{ key: string; set: Set<string> } | null>(null);
  const collapsed = collapsedState?.key === groupsKey ? collapsedState.set : initiallyCollapsed(pivot.rows, levels, format?.table?.expandTo);
  const toggle = (row: PivotRow) => {
    const next = new Set(collapsed);
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    setCollapsed({ key: groupsKey, set: next });
  };
  const groups = ordered.filter((row) => isGroupRow(row, levels));
  const shownRows = visibleWithCollapsed(ordered, collapsed);
  const headerRows = pivot.columnField ? columnHeaderRows(pivot, (level, value) => pivotValueLabel(pivot, level, value, true)) : [];
  const headerDepth = headerRows.length + 1;
  const rowLabel = (row: PivotRow): string => {
    if (row.kind === "grand_total") return "Grand total";
    const level = Math.max(0, row.depth - 1);
    const value = row.dimensions[level];
    return value === null ? "(blank)" : showValue(value, pivot.rowFields[level]);
  };
  const toggleButton = (row: PivotRow) => {
    if (!isGroupRow(row, levels)) return null;
    const open = !collapsed.has(row.key);
    const name = row.dimensions.slice(0, row.depth).map((value, index) => (value === null ? "(blank)" : showValue(value, pivot.rowFields[index]))).join(" · ");
    return (
      <button type="button" className={styles.pivotToggle} aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${name}`} onClick={() => toggle(row)}>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
    );
  };
  return (
    <div className={styles.pivot}>
      {exportFor || groups.length ? (
        <div className={styles.pivotTools}>
          {groups.length ? (
            <>
              <Button size="small" variant="secondary" disabled={collapsed.size === 0} onClick={() => setCollapsed({ key: groupsKey, set: new Set() })}>Open all</Button>
              <Button size="small" variant="secondary" disabled={collapsed.size === groups.length} onClick={() => setCollapsed({ key: groupsKey, set: new Set(groups.map((row) => row.key)) })}>Close all</Button>
            </>
          ) : null}
          {exportFor ? (
            <>
              <Button size="small" variant="secondary" disabled={exporting} onClick={() => void download("csv")}>Export CSV</Button>
              <Button size="small" variant="secondary" disabled={exporting} onClick={() => void download("xlsx")}>Export Excel</Button>
            </>
          ) : null}
        </div>
      ) : null}
      {exportError ? <Notice tone="error">{exportError}</Notice> : null}
      <div className={`${ui.tableWrap} ${styles.pivotWrap}`}>
        <table className={`${ui.table} ${look.className}`} style={look.style} aria-label={`${title} pivot table`}>
          <caption>{title}</caption>
          <thead>
            {pivot.columnField ? (
              <>
                {headerRows.map((cells, level) => (
                  <tr key={`level-${level}`}>
                    {level === 0
                      ? stepped
                        ? <th scope="col" rowSpan={headerDepth}>{pivot.rowFields.map((field) => fieldLabel(field.label)).join(" › ")}</th>
                        : pivot.rowFields.map((field) => <th key={field.key} scope="col" rowSpan={headerDepth}>{fieldLabel(field.label)}</th>)
                      : null}
                    {cells.map((cell) => (
                      <th key={cell.key} scope="colgroup" colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{cell.text}</th>
                    ))}
                  </tr>
                ))}
                <tr>{pivot.columns.map((column) => <th key={column.key} scope="col" className={ui.num}>{column.measure.label}</th>)}</tr>
              </>
            ) : (
              <tr>
                {stepped
                  ? <th scope="col">{pivot.rowFields.map((field) => fieldLabel(field.label)).join(" › ")}</th>
                  : pivot.rowFields.map((field) => <th key={field.key} scope="col">{fieldLabel(field.label)}</th>)}
                {pivot.columns.map((column) => <th key={column.key} scope="col" className={ui.num}>{column.measure.label}</th>)}
              </tr>
            )}
          </thead>
          <tbody>
            {shownRows.map((row) => {
              // In the stepped layout a group's row is its heading; with its subtotal turned off, its figures are left blank.
              const blank = stepped && row.kind === "subtotal" && offLevels.has(row.depth);
              return (
              <tr key={row.key} className={row.kind !== "detail" && !(stepped && row.kind === "subtotal" && blank) ? totalRowClass(format?.table, styles.pivotTotal) : undefined}>
                {stepped ? (
                  <th scope="row" className={styles.pivotStep} style={{ paddingInlineStart: `${8 + Math.max(0, row.depth - 1) * 16}px` }}>
                    {toggleButton(row)}
                    {rowLabel(row)}
                  </th>
                ) : (
                  pivot.rowFields.map((field, index) => (
                    <th key={field.key} scope="row">
                      {row.kind === "subtotal" && index === row.depth ? toggleButton(row) : null}
                      {pivotRowLabel(row, index, field)}
                    </th>
                  ))
                )}
                {pivot.columns.map((column) => (
                  blank ? <td key={column.key} className={ui.num} /> :
                  <FormattedCell
                    key={column.key}
                    className={ui.num}
                    format={row.kind === "detail" ? format : undefined}
                    valueIndex={measureKeys.indexOf(column.measure.key)}
                    value={row.cells[column.key] ?? null}
                    range={ranges.get(column.key) ?? null}
                    field={row.dimensions[0] ?? null}
                  >
                    {onDrill ? (
                      <button
                        type="button"
                        className={styles.pivotCell}
                        aria-label={`Show rows for ${stepped ? rowLabel(row) : pivot.rowFields.map((field, index) => pivotRowLabel(row, index, field)).filter(Boolean).join(" · ")}, ${pivotColumnLabel(column, pivot)}, ${column.measure.label}`}
                        onClick={() => click(row, column)}
                      >
                        {showValue(row.cells[column.key] ?? null, column.measure)}
                      </button>
                    ) : (
                      showValue(row.cells[column.key] ?? null, column.measure)
                    )}
                  </FormattedCell>
                ))}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A pie keeps its 7 largest slices and adds the rest up (exactly) as Other, so no two slices share a colour. */
function foldSlices(rows: QueryResult["rows"], key: string): QueryResult["rows"] {
  if (rows.length <= 8) return rows;
  const sorted = [...rows].sort((a, b) => cmp(dec(b[key] ?? "0"), dec(a[key] ?? "0")));
  const other = sum(sorted.slice(7).map((row) => dec(row[key] ?? "0")));
  return [...sorted.slice(0, 7), { category: "Other", [key]: toPlainString(other) }];
}

function blankQuery(table: TableInfo | undefined): TileQuery {
  const date = table?.columns.find((column) => isDate(column.type));
  const text = table?.columns.find((column) => !isDate(column.type) && !isNumber(column.type));
  const money = table?.columns.find((column) => /^DECIMAL\(\d+,2\)$/.test(column.type)) ?? table?.columns.find((column) => isNumber(column.type));
  return {
    table: table?.name ?? "",
    groupBy: date ? { field: date.name, grain: "month" } : text ? { field: text.name } : null,
    pivot: null,
    measures: [money ? { label: "", aggregate: "sum" as const, field: money.name } : { label: "", aggregate: "count" as const }].map((measure) => ({
      ...measure,
      label: measureLabel(measure, table?.name ?? ""),
    })),
    filters: [],
    dateField: date?.name ?? null,
    sort: { by: "category", direction: "asc" },
    limit: null,
  };
}

/** A second grouping inside the first (#376 phase 2), for the chart types that use one. */
function SecondGrouping({ visual, query, columns, onChange }: { visual: Visual; query: TileQuery; columns: ColumnInfo[]; onChange: (query: TileQuery) => void }) {
  const setting = SECOND_GROUPING[visual];
  if (!setting || !query.groupBy) return null;
  const type = columns.find((column) => column.name === query.breakdown?.field)?.type ?? "";
  return (
    <>
      <Field label={setting.label} hint={setting.hint}>
        <select
          value={query.breakdown?.field ?? ""}
          onChange={(event) => {
            const field = event.target.value;
            const fieldType = columns.find((column) => column.name === field)?.type ?? "";
            onChange({ ...query, breakdown: field ? { field, ...(isDate(fieldType) ? { grain: "month" as Grain } : {}) } : null, measures: query.measures.map((measure) => ({ ...measure, compare: undefined })) });
          }}
        >
          {setting.none ? <option value="">{setting.none}</option> : <option value="">Choose a field</option>}
          {columnOptions(columns.filter((column) => column.name !== query.groupBy?.field || isDate(column.type)))}
        </select>
      </Field>
      {query.breakdown && isDate(type) ? (
        <Field label="By">
          <select aria-label={`${setting.label} by`} value={query.breakdown.grain ?? "month"} onChange={(event) => onChange({ ...query, breakdown: { field: query.breakdown!.field, grain: event.target.value as Grain } })}>
            {GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
          </select>
        </Field>
      ) : null}
    </>
  );
}

/** A chart's drill-down levels (decision 755): dates by financial or calendar year, or fields one inside another. */
function DrillSettings({ drill, usable, query, columns, onChange }: { drill: TileDrill | undefined; usable: boolean; query: TileQuery; columns: ColumnInfo[]; onChange: (drill: TileDrill | undefined) => void }) {
  const groupField = query.groupBy?.field ?? "";
  const dated = isDate(columns.find((column) => column.name === groupField)?.type ?? "");
  const kind = !drill ? "" : drill.levels[0].grain === "fyear" ? "fyear" : drill.levels[0].grain ? "year" : "fields";
  const choose = (value: string) => {
    if (!value) return onChange(undefined);
    if (value === "fyear" || value === "year") return onChange({ levels: dateHierarchy(groupField, value === "fyear") });
    const next = columns.find((column) => column.name !== groupField && !isNumber(column.type));
    onChange({ levels: [{ field: groupField, ...(query.groupBy?.grain ? { grain: query.groupBy.grain } : {}) }, ...(next ? [{ field: next.name, ...(isDate(next.type) ? { grain: "month" as Grain } : {}) }] : [])] });
  };
  return (
    <fieldset className={styles.sizeFields}>
      <legend>Drill down</legend>
      {!usable ? <p className={ui.muted}>Group the chart by something (with no second grouping) to drill down.</p> : (
        <>
          <Field label="Levels" hint={kind === "fyear" ? "Financial years follow the balance date in Settings, named by the year they end (FY2027)." : "Readers choose Drill down on click, then a group, to see the next level inside it."}>
            <select value={kind} onChange={(event) => choose(event.target.value)}>
              <option value="">None</option>
              {dated ? <option value="fyear">Financial year, quarter, month, day</option> : null}
              {dated ? <option value="year">Calendar year, quarter, month, day</option> : null}
              <option value="fields">{fieldLabel(groupField)}, then other fields</option>
            </select>
          </Field>
          {kind === "fields" && drill ? (
            <>
              {drill.levels.slice(1).map((level, index) => (
                <div key={index} className={styles.pivotField}>
                  <Field label={`Level ${index + 2}`}>
                    <select value={level.field} onChange={(event) => {
                      const column = columns.find((entry) => entry.name === event.target.value);
                      const levels = [...drill.levels];
                      levels[index + 1] = { field: event.target.value, ...(column && isDate(column.type) ? { grain: "month" as Grain } : {}) };
                      onChange({ levels });
                    }}>
                      {columnOptions(columns.filter((column) => !isNumber(column.type) && (column.name === level.field || !drill.levels.some((entry) => entry.field === column.name))))}
                    </select>
                  </Field>
                  <Button size="small" variant="danger" aria-label={`Remove level ${index + 2}`} disabled={drill.levels.length <= 2} onClick={() => onChange({ levels: drill.levels.filter((_entry, at) => at !== index + 1) })}>Remove</Button>
                </div>
              ))}
              <div className={styles.addRow}>
                <Button size="small" variant="secondary" disabled={drill.levels.length >= MAX_DRILL_LEVELS} onClick={() => {
                  const column = columns.find((entry) => !isNumber(entry.type) && !drill.levels.some((level) => level.field === entry.name));
                  if (column) onChange({ levels: [...drill.levels, { field: column.name, ...(isDate(column.type) ? { grain: "month" as Grain } : {}) }] });
                }}>Add a level</Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

/** Remembered in this browser only: whether the chart panel shows advanced settings (decision 751). */
const ADVANCED_KEY = "tohyee.analytics.advancedSettings";
function readAdvanced(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Adding or changing a tile, with a live preview. */
function TileEditor({
  saving,
  organisationId,
  tables,
  tile,
  filters,
  onSave,
  onCancel,
  defaults,
  themeClass,
  theme,
  onSetDefault,
  others = [],
}: {
  saving: boolean;
  organisationId: string;
  tables: TableInfo[];
  tile: Tile | null;
  filters: Filters;
  onSave: (tile: Tile) => void;
  onCancel: () => void;
  /** The report's default look per chart type (#376). */
  defaults?: VisualDefaults;
  /** The report theme's class, so the preview looks like the report. */
  themeClass?: string;
  /** The report's theme, for checking colours chosen on the chart. */
  theme?: ReportTheme;
  onSetDefault?: (visual: DefaultableVisual, format: ChartFormat | undefined) => void;
  /** The page's other tiles, for how a click on this one changes them (decision 754). */
  others?: Array<{ id: string; title: string }>;
}) {
  const { can } = useWorkspace();
  const [fieldSearch, setFieldSearch] = useState("");
  const [title, setTitle] = useState(tile?.title ?? "");
  const [visual, setVisual] = useState<Visual>(tile && !isItemVisual(tile.visual) ? tile.visual : "column");
  const [width, setWidth] = useState<TileWidth>(tile?.width ?? "half");
  const [height, setHeight] = useState<TileHeight>(tile?.height ?? "medium");
  const [query, setQuery] = useState<TileQuery>(tile?.query ?? blankQuery(tables[0]));
  const [format, setFormat] = useState<ChartFormat | undefined>(tile?.format);
  // Drill-down levels and how clicks change other tiles (decisions 754-755).
  const [drill, setDrill] = useState<TileDrill | undefined>(tile?.drill);
  const [interactions, setInteractions] = useState<Record<string, InteractionMode>>(tile?.interactions ?? {});
  // Its own dates (decision 758).
  const [tileDates, setTileDates] = useState<TileDates | undefined>(tile?.dates);
  const yearEndMonth = useContext(YearEndMonth);
  const [savedVersion, setSavedVersion] = useState(0);
  // The panel's tab, specialist chart types and advanced settings (#387, decisions 750-751).
  const [tab, setTab] = useState<PanelTab>("data");
  const [moreTypes, setMoreTypes] = useState(() => isSpecialistVisual(visual));
  const [advanced, setAdvancedState] = useState(readAdvanced);
  const setAdvanced = (on: boolean) => {
    setAdvancedState(on);
    try {
      window.localStorage.setItem(ADVANCED_KEY, on ? "1" : "0");
    } catch {
      // Not remembered; it still applies to this chart.
    }
  };
  const drillUsable = DRILLABLE.includes(visual) && Boolean(query.groupBy) && !query.breakdown;
  const shownVisuals = VISUALS.filter((entry) => moreTypes || !isSpecialistVisual(entry.value) || entry.value === visual);
  const table = tables.find((entry) => entry.name === query.table);
  const columns = table?.columns ?? [];
  const numbers = columns.filter((column) => isNumber(column.type));
  const groupType = columns.find((column) => column.name === query.groupBy?.field)?.type ?? "";
  const pivotRows = query.pivot?.rows ?? [];
  const subColumns = query.pivot?.subColumns ?? [];
  const usedPivotFields = new Set([...pivotRows.map((dimension) => dimension.field), ...(query.pivot?.column ? [query.pivot.column.field] : []), ...subColumns.map((dimension) => dimension.field)]);
  const preview = useTileResult(organisationId, query.table ? query : null, tileDates && query.dateField ? { ...filters, ...effectiveDates(tileDates, filters, todayInBrowser(), yearEndMonth) } as Filters : filters);
  // The preview's groups, for colouring a group and limiting a date axis (#376).
  const groupValues = preview?.result && query.groupBy ? preview.result.rows.map((row) => row.category) : null;

  // A label Tohyee filled in follows the value's column and calculation; a typed one stays (#329).
  const setMeasure = (index: number, patch: Partial<Measure>) =>
    setQuery({ ...query, measures: query.measures.map((measure, at) => (at === index ? changeMeasure(measure, patch, query.table) : measure)) });
  const changeVisual = (next: Visual) => {
    if (next === "pivot") {
      const current = query.groupBy;
      const field = current?.field ?? columns[0]?.name;
      const fieldType = columns.find((column) => column.name === field)?.type ?? "";
      const dimension = field
        ? { field, ...(isDate(fieldType) ? { grain: current?.grain === "quarter" || current?.grain === "year" ? current.grain : "month" as const } : {}) }
        : null;
      setQuery({
        ...query,
        groupBy: null,
        pivot: { rows: dimension ? [dimension] : [], column: null },
        measures: query.measures.map((measure) => ({
          ...measure,
          ...(measure.aggregate === "count_distinct" ? { aggregate: "count" as const } : {}),
          compare: undefined,
        })),
      });
    } else if (visual === "pivot" && query.pivot) {
      const first = query.pivot.rows[0];
      setQuery({
        ...query,
        pivot: null,
        groupBy: first ? { field: first.field, ...(first.grain ? { grain: first.grain } : {}) } : null,
      });
    }
    if (query.breakdown && !SECOND_GROUPING[next]) {
      // Only some chart types use a second grouping.
      setQuery((current) => ({ ...current, breakdown: null }));
    }
    if (SECOND_GROUPING_REQUIRED.includes(next) && !query.breakdown) {
      // A heat map or Sankey needs a second grouping: start with the first other text field.
      const first = query.groupBy ?? (columns[0] ? { field: columns[0].name } : null);
      const other = columns.find((column) => column.name !== first?.field && !isDate(column.type) && !isNumber(column.type)) ?? columns.find((column) => column.name !== first?.field);
      if (first && other) {
        setQuery((current) => ({
          ...current,
          groupBy: current.groupBy ?? first,
          breakdown: { field: other.name, ...(isDate(other.type) ? { grain: "month" as Grain } : {}) },
          measures: current.measures.map((measure) => ({ ...measure, compare: undefined })),
        }));
      }
    }
    if (next === "calendar") {
      // A calendar heat map is grouped by a date, by day.
      const date = columns.find((column) => column.name === query.groupBy?.field && isDate(column.type)) ?? columns.find((column) => isDate(column.type));
      if (date) setQuery((current) => ({ ...current, groupBy: { field: date.name, grain: "day" }, breakdown: null, measures: current.measures.map((measure) => ({ ...measure, compare: undefined })) }));
    }
    if (next === "filledmap") {
      // A filled map is grouped by a region or district name: start with a field called that, one value.
      const area = columns.find((column) => !isNumber(column.type) && /region|district|territor|council|city/i.test(column.name));
      setQuery((current) => ({
        ...current,
        groupBy: area && !current.groupBy ? { field: area.name } : current.groupBy,
        measures: current.measures.slice(0, 1).map((measure) => ({ ...measure, compare: undefined })),
      }));
    }
    if (next === "pointmap") {
      // A map with points needs a latitude and a longitude (the average of each group's), then a value to size them.
      const latitude = columns.find((column) => isNumber(column.type) && /^(lat|latitude)$|latitude/i.test(column.name));
      const longitude = columns.find((column) => isNumber(column.type) && /^(lon|lng|long|longitude)$|longitude/i.test(column.name));
      if (latitude && longitude && !(query.measures[0]?.field === latitude.name && query.measures[1]?.field === longitude.name)) {
        setQuery((current) => ({
          ...current,
          measures: [
            { label: "Latitude", aggregate: "avg", field: latitude.name },
            { label: "Longitude", aggregate: "avg", field: longitude.name },
            ...current.measures.filter((measure) => measure.field !== latitude.name && measure.field !== longitude.name).slice(0, 1).map((measure) => ({ ...measure, compare: undefined })),
          ],
        }));
      }
    }
    if (next === "gauge" && query.groupBy) {
      // A gauge shows one total.
      setQuery((current) => ({ ...current, groupBy: null, measures: current.measures.map((measure) => ({ ...measure, compare: undefined })) }));
    }
    if (visual === "kpi" && next !== "kpi") {
      // The previous period, a target and the trend belong to key figures.
      setQuery((current) => ({
        ...current,
        sparkline: undefined,
        measures: current.measures.map((measure) => (measure.compare === "previous_period" ? { ...measure, compare: undefined } : measure)),
      }));
    }
    setVisual(next);
  };

  return (
    <section className={styles.editor} aria-label="Chart editor">
      <aside className={styles.fieldsPanel}>
        <h2>Data</h2><p className={ui.muted}>Fields in the selected source</p>
        <Field label="Search fields"><input type="search" value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder="Find a field…" /></Field>
        <div className={styles.fieldList}>{columns.filter((column) => `${column.name} ${fieldLabel(column.name)}`.toLowerCase().includes(fieldSearch.toLowerCase().trim())).map((column) => <div className={styles.fieldItem} key={column.name} title={`${query.table}.${column.name}`}><span className={styles.fieldType}>{isNumber(column.type) ? "123" : isDate(column.type) ? "Date" : column.type === "BOOLEAN" ? "Y/N" : "ABC"}</span><span>{fieldLabel(column.name)}<small>{column.name}</small></span></div>)}</div>
        {!columns.length ? <p>No fields loaded. <Link href="/analytics/sources">Add a data source</Link>.</p> : null}
        {can("admin") ? <Link href="/analytics/shaping">Prepare or combine data →</Link> : null}
      </aside>
      <div className={styles.canvasPanel}>
        <div className={styles.canvasHeading}><span className={styles.eyebrow}>REPORT CANVAS · LIVE PREVIEW</span><h2>{title || "Untitled chart"}</h2><p className={ui.muted}>Using the report’s date range and filters</p></div>
        <div className={styles.visualPicker} role="group" aria-label="Chart type">
          {shownVisuals.map((entry) => <button type="button" key={entry.value} aria-pressed={visual === entry.value} onClick={() => changeVisual(entry.value)}>{entry.label}</button>)}
          <button type="button" className={styles.moreTypes} aria-expanded={moreTypes} onClick={() => setMoreTypes(!moreTypes)}>{moreTypes ? "Fewer chart types" : "More chart types…"}</button>
        </div>
      <h3 className={styles.subheading}>
        Preview {preview?.result?.truncated ? <Badge tone="amber">first 5,000 rows</Badge> : null}
      </h3>
      <div className={`${styles.preview} ${themeClass ?? ""}`}>
        {!preview ? (
          <p className={ui.muted}>Working it out…</p>
        ) : preview.error ? (
          <Notice tone="error">{preview.error}</Notice>
        ) : (
          <TileResult tile={{ title: title || "Preview", visual, format: mergeFormats(defaults?.[visual], format), height, query }} result={preview.result!} />
        )}
      </div>

      </div>
      <aside className={styles.propertiesPanel} aria-label="Chart properties">
        <h2>{tile ? "Chart properties" : "Add a chart"}</h2>
        <fieldset disabled={saving} className={styles.propertyFields}>
      <div className={styles.propertyGrid}>
        <Field label="Title">
          <input value={title} maxLength={100} placeholder="e.g. Sales by month" onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Show as" hint={moreTypes ? undefined : "More chart types (waterfall, maps, Sankey and others) are under the preview."}>
          <select value={visual} onChange={(event) => changeVisual(event.target.value as Visual)}>
            {shownVisuals.filter((entry) => !isSpecialistVisual(entry.value)).map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
            {shownVisuals.some((entry) => isSpecialistVisual(entry.value)) ? (
              <optgroup label="More chart types">
                {shownVisuals.filter((entry) => isSpecialistVisual(entry.value)).map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </Field>
      </div>
      <PanelTabs
        id={`chart-${tile?.id ?? "new"}`}
        label="Chart settings"
        tabs={PANEL_TABS.map((value) => ({ value, label: PANEL_TAB_LABELS[value] }))}
        chosen={tab}
        onChoose={setTab}
        panels={{
          data: (
            <>
      <div className={styles.propertyGrid}>
        <Field label="Data source" hint={tableDescription(query.table) || undefined}>
          <select value={query.table} onChange={(event) => setQuery(blankQuery(tables.find((entry) => entry.name === event.target.value)))}>
            {[...tables].sort((a, b) => tableLabel(a.name).localeCompare(tableLabel(b.name))).map((entry) => (
              <option key={entry.name} value={entry.name} title={entry.name}>
                {tableLabel(entry.name)}
              </option>
            ))}
          </select>
        </Field>
        {visual === "pivot" ? (
          <>
            {pivotRows.map((dimension, index) => (
              <div className={styles.pivotField} key={index}>
                <Field label={`Pivot row ${index + 1}`}>
                  <select
                    aria-label={`Pivot row ${index + 1}`}
                    value={dimension.field}
                    onChange={(event) => {
                      const field = event.target.value;
                      const type = columns.find((column) => column.name === field)?.type ?? "";
                      const rows = [...pivotRows];
                      rows[index] = { field, ...(isDate(type) ? { grain: "month" } : {}) };
                      setQuery({ ...query, pivot: { ...query.pivot, rows, column: query.pivot?.column ?? null } });
                    }}
                  >
                    {columnOptions(columns.filter((column) => !usedPivotFields.has(column.name) || column.name === dimension.field))}
                  </select>
                </Field>
                {isDate(columns.find((column) => column.name === dimension.field)?.type ?? "") ? (
                  <Field label="Group by">
                    <select
                      aria-label={`Pivot row ${index + 1} date grouping`}
                      value={dimension.grain ?? "month"}
                      onChange={(event) => {
                        const rows = [...pivotRows];
                        rows[index] = { ...dimension, grain: event.target.value as PivotGrain };
                        setQuery({ ...query, pivot: { ...query.pivot, rows, column: query.pivot?.column ?? null } });
                      }}
                    >
                      {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                    </select>
                  </Field>
                ) : null}
                <Button
                  size="small"
                  variant="danger"
                  aria-label={`Remove pivot row ${index + 1}`}
                  disabled={pivotRows.length === 1}
                  onClick={() => setQuery({ ...query, pivot: { ...query.pivot, rows: pivotRows.filter((_row, at) => at !== index), column: query.pivot?.column ?? null } })}
                >
                  Remove row
                </Button>
              </div>
            ))}
            <div className={styles.addRow}>
              <Button
                size="small"
                variant="secondary"
                disabled={pivotRows.length >= 5 || columns.every((column) => usedPivotFields.has(column.name))}
                onClick={() => {
                  const column = columns.find((entry) => !usedPivotFields.has(entry.name));
                  if (!column) return;
                  setQuery({
                    ...query,
                    pivot: {
                      ...query.pivot,
                      rows: [...pivotRows, { field: column.name, ...(isDate(column.type) ? { grain: "month" as const } : {}) }],
                      column: query.pivot?.column ?? null,
                    },
                  });
                }}
              >
                Add a row field
              </Button>
            </div>
            <Field label="Pivot column">
              <select
                value={query.pivot?.column?.field ?? ""}
                onChange={(event) => {
                  const field = event.target.value;
                  const type = columns.find((column) => column.name === field)?.type ?? "";
                  setQuery({
                    ...query,
                    pivot: {
                      rows: pivotRows,
                      column: field ? { field, ...(isDate(type) ? { grain: "month" as const } : {}) } : null,
                      // Columns inside need an outer one; a field can only be used once.
                      ...(field && subColumns.some((entry) => entry.field !== field) ? { subColumns: subColumns.filter((entry) => entry.field !== field) } : {}),
                    },
                  });
                }}
              >
                <option value="">None</option>
                {columnOptions(columns.filter((column) => !pivotRows.some((row) => row.field === column.name)))}
              </select>
            </Field>
            {query.pivot?.column && isDate(columns.find((column) => column.name === query.pivot?.column?.field)?.type ?? "") ? (
              <Field label="Column date grouping">
                <select
                  value={query.pivot.column.grain ?? "month"}
                  onChange={(event) => setQuery({
                    ...query,
                    pivot: { ...query.pivot, rows: pivotRows, column: { ...query.pivot!.column!, grain: event.target.value as PivotGrain } },
                  })}
                >
                  {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                </select>
              </Field>
            ) : null}
            {query.pivot?.column ? (
              <>
                {subColumns.map((dimension, index) => {
                  const setSub = (next: PivotDimension | null) => {
                    const list = [...subColumns];
                    if (next) list[index] = next;
                    else list.splice(index, 1);
                    setQuery({ ...query, pivot: { ...query.pivot!, subColumns: list.length ? list : undefined } });
                  };
                  const type = columns.find((column) => column.name === dimension.field)?.type ?? "";
                  return (
                    <div className={styles.pivotField} key={`sub-${index}`}>
                      <Field label={`Pivot column ${index + 2} (inside)`}>
                        <select
                          aria-label={`Pivot column ${index + 2}`}
                          value={dimension.field}
                          onChange={(event) => {
                            const field = event.target.value;
                            const fieldType = columns.find((column) => column.name === field)?.type ?? "";
                            setSub({ field, ...(isDate(fieldType) ? { grain: "month" as const } : {}) });
                          }}
                        >
                          {columnOptions(columns.filter((column) => !usedPivotFields.has(column.name) || column.name === dimension.field))}
                        </select>
                      </Field>
                      {isDate(type) ? (
                        <Field label="Group by">
                          <select aria-label={`Pivot column ${index + 2} date grouping`} value={dimension.grain ?? "month"} onChange={(event) => setSub({ ...dimension, grain: event.target.value as PivotGrain })}>
                            {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                          </select>
                        </Field>
                      ) : null}
                      <Button size="small" variant="danger" aria-label={`Remove pivot column ${index + 2}`} onClick={() => setSub(null)}>Remove column</Button>
                    </div>
                  );
                })}
                <div className={styles.addRow}>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={subColumns.length >= 2 || columns.every((column) => usedPivotFields.has(column.name))}
                    onClick={() => {
                      const column = columns.find((entry) => !usedPivotFields.has(entry.name));
                      if (!column) return;
                      setQuery({ ...query, pivot: { ...query.pivot!, subColumns: [...subColumns, { field: column.name, ...(isDate(column.type) ? { grain: "month" as const } : {}) }] } });
                    }}
                  >
                    Add a column inside
                  </Button>
                </div>
              </>
            ) : null}
          </>
        ) : visual === "gauge" ? null : (
          <>
            <Field label="Group by">
              <select
                value={query.groupBy?.field ?? ""}
                onChange={(event) => {
                  const field = event.target.value;
                  const type = columns.find((column) => column.name === field)?.type ?? "";
                  setQuery({
                    ...query,
                    groupBy: field ? { field, ...(isDate(type) ? { grain: "month" as Grain } : {}) } : null,
                    breakdown: field && field !== query.breakdown?.field ? query.breakdown : null,
                    // Grouped by a date, a value can compare with last year; the previous period and the trend are for one total.
                    measures: query.measures.map((measure) => ({
                      ...measure,
                      compare: field ? (isDate(type) && measure.compare === "previous_year" ? measure.compare : undefined) : measure.compare,
                    })),
                    sparkline: field ? undefined : query.sparkline,
                  });
                }}
              >
                <option value="">Nothing (one total)</option>
                {columnOptions(columns)}
              </select>
            </Field>
            {isDate(groupType) ? (
              <Field label="By">
                <select value={query.groupBy?.grain ?? "month"} onChange={(event) => setQuery({ ...query, groupBy: { field: query.groupBy!.field, grain: event.target.value as Grain } })}>
                  {GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                </select>
              </Field>
            ) : null}
            <SecondGrouping visual={visual} query={query} columns={columns} onChange={setQuery} />
          </>
        )}
        <Field label="Date range applies to" hint="The dashboard's From and To.">
          <select value={query.dateField ?? ""} onChange={(event) => setQuery({ ...query, dateField: event.target.value || null })}>
            <option value="">No date</option>
            {columnOptions(columns.filter((column) => isDate(column.type)))}
          </select>
        </Field>
        {query.dateField ? (
          <Field label="Dates for this chart" hint={tileDates ? "This chart keeps these dates whatever the report's dates are." : undefined}>
            <select
              value={!tileDates ? "" : "preset" in tileDates ? tileDates.preset : "fixed"}
              onChange={(event) => {
                const value = event.target.value;
                setTileDates(!value ? undefined : value === "fixed" ? { from: filters.from || null, to: filters.to || null } : isDatePreset(value) ? { preset: value } : undefined);
              }}
            >
              <option value="">The report&apos;s dates</option>
              {DATE_PRESETS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              <option value="fixed">Fixed dates</option>
            </select>
          </Field>
        ) : null}
        {query.dateField && tileDates && !("preset" in tileDates) ? (
          <>
            <Field label="From">
              <DateInput value={tileDates.from ?? ""} onChange={(event) => setTileDates({ ...tileDates, from: event.target.value || null })} />
            </Field>
            <Field label="To">
              <DateInput value={tileDates.to ?? ""} onChange={(event) => setTileDates({ ...tileDates, to: event.target.value || null })} />
            </Field>
          </>
        ) : null}
        {visual !== "pivot" ? <Field label="Order by">
          <select
            value={`${query.sort.by}-${query.sort.direction}`}
            onChange={(event) => {
              const [by, direction] = event.target.value.split("-") as ["category" | "value", "asc" | "desc"];
              setQuery({ ...query, sort: { by, direction } });
            }}
          >
            <option value="category-asc">Group, A to Z / oldest first</option>
            <option value="category-desc">Group, Z to A / newest first</option>
            <option value="value-desc">First value, largest first</option>
            <option value="value-asc">First value, smallest first</option>
          </select>
        </Field> : null}
        {visual !== "pivot" ? <Field label="Top" hint="Blank for all.">
          <input
            inputMode="numeric"
            value={query.limit ?? ""}
            onChange={(event) => setQuery({ ...query, limit: event.target.value ? Number(event.target.value.replace(/\D/g, "")) || null : null })}
          />
        </Field> : null}
      </div>

      <h3 className={styles.subheading}>Values</h3>
      {query.measures.map((measure, index) => (
        <div key={index} className={styles.measureRow}>
          <input aria-label={`Value ${index + 1} label`} value={measure.label} maxLength={80} onChange={(event) => setMeasure(index, { label: event.target.value })} />
          {measure.aggregate === "formula" ? (
            <FormulaField index={index} measure={measure} siblings={query.measures} onChange={(formula) => setMeasure(index, { formula })} />
          ) : (
          <select aria-label={`Value ${index + 1} how`} value={measure.aggregate} onChange={(event) => {
              const aggregate = event.target.value as Aggregate;
              setMeasure(index, { aggregate, ...(aggregate === "count" || aggregate === "count_distinct" ? { negate: undefined } : {}) });
            }}>
            {AGGREGATES.filter((entry) => visual !== "pivot" || entry.value !== "count_distinct").map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          )}
          {measure.aggregate !== "count" && measure.aggregate !== "formula" ? (
            <select aria-label={`Value ${index + 1} of`} value={measure.field ?? ""} onChange={(event) => setMeasure(index, { field: event.target.value })}>
              <option value="">Choose a column</option>
              {columnOptions(["sum", "avg"].includes(measure.aggregate) ? numbers : columns)}
            </select>
          ) : null}
          {["sum", "avg"].includes(measure.aggregate) ? (
            <select aria-label={`Value ${index + 1} times`} value={measure.times ?? ""} onChange={(event) => setMeasure(index, { times: event.target.value || undefined })}>
              <option value="">× nothing</option>
              {columnOptions(numbers, "× ")}
            </select>
          ) : null}
          {["sum", "avg", "min", "max"].includes(measure.aggregate) ? (
            <label className={ui.checkbox} title="Each amount negated, e.g. so sales (credits) show as positive">
              <input type="checkbox" checked={measure.negate === true} onChange={(event) => setMeasure(index, { negate: event.target.checked || undefined })} /> other way
              round
            </label>
          ) : null}
          {query.groupBy?.grain && !(visual === "kpi" && index === 0) ? (
            <label className={ui.checkbox}>
              <input
                type="checkbox"
                checked={measure.compare === "previous_year"}
                onChange={(event) => setMeasure(index, { compare: event.target.checked ? "previous_year" : undefined })}
              />{" "}
              and last year
            </label>
          ) : null}
          <ValueRules measure={measure} />
          {visual !== "pivot" ? (
            <SaveValueButton
              organisationId={organisationId}
              table={query.table}
              measure={measure}
              siblings={query.measures}
              number={format?.series?.[tileValueNames(query.measures.slice(0, index)).length]?.number}
              onSaved={() => setSavedVersion((version) => version + 1)}
            />
          ) : null}
          <Button size="small" variant="danger" disabled={query.measures.length === 1} onClick={() => setQuery({ ...query, measures: query.measures.filter((_m, at) => at !== index) })}>
            Remove
          </Button>
        </div>
      ))}
      <div className={styles.addRow}>
        <Button
          size="small"
          variant="secondary"
          disabled={query.measures.length >= 6}
          onClick={() => setQuery({ ...query, measures: [...query.measures, { label: measureLabel({ aggregate: "count" }, query.table), aggregate: "count" }] })}
        >
          Add a value
        </Button>
        {visual !== "pivot" ? (
          <Button
            size="small"
            variant="secondary"
            disabled={query.measures.length >= 6}
            onClick={() =>
              setQuery({
                ...query,
                measures: [...query.measures, { label: `Calculated ${query.measures.filter((measure) => measure.aggregate === "formula").length + 1}`, aggregate: "formula", formula: "" }],
              })
            }
          >
            Add a calculated value
          </Button>
        ) : null}
      </div>
      {visual !== "pivot" && query.table ? (
        <SavedValuesPicker
          organisationId={organisationId}
          table={query.table}
          version={savedVersion}
          disabled={query.measures.length >= 6}
          onAdd={(measure, number) => {
            // A saved value's label must be its own on this chart, so a formula knows which one it means.
            const taken = new Set(query.measures.map((entry) => entry.label));
            let label = measure.label;
            for (let count = 2; taken.has(label); count += 1) label = `${measure.label} ${count}`;
            const measures = [...query.measures, { ...measure, label }];
            setQuery({ ...query, measures });
            if (number) {
              const at = tileValueNames(query.measures).length;
              const series = tileValueNames(measures).map((_name, position) => format?.series?.[position] ?? {});
              series[at] = { ...series[at], number };
              setFormat({ ...format, series });
            }
          }}
        />
      ) : null}

      <h3 className={styles.subheading}>Only include rows where</h3>
      <TileFilters organisationId={organisationId} table={query.table} columns={columns} filters={query.filters} onChange={(filters) => setQuery({ ...query, filters })} />

      {visual === "kpi" ? <KeyFigureSettings query={query} onQuery={setQuery} format={format} onFormat={setFormat} part="data" /> : null}

            </>
          ),
          style: (
            <>
      <fieldset className={styles.sizeFields}>
        <legend>Size in the report</legend>
        <div className={styles.propertyGrid}>
        <Field label="Width" hint="Of a row; on phones every chart is full width.">
          <select value={width} onChange={(event) => setWidth(event.target.value as TileWidth)}>
            {TILE_WIDTHS.map((entry) => <option key={entry} value={entry}>{WIDTH_LABELS[entry]}</option>)}
          </select>
        </Field>
        {visual !== "kpi" && visual !== "table" && visual !== "pivot" ? (
          <Field label="Height">
            <select value={height} onChange={(event) => setHeight(event.target.value as TileHeight)}>
              {TILE_HEIGHTS.map((entry) => <option key={entry} value={entry}>{HEIGHT_LABELS[entry]}</option>)}
            </select>
          </Field>
        ) : null}
        </div>
      </fieldset>
      <ChartFormatPanel
        visual={visual}
        values={tileValueNames(query.measures)}
        format={format}
        onChange={setFormat}
        inherited={defaults?.[visual]}
        onSetDefault={onSetDefault ? (look) => onSetDefault(visual, look) : undefined}
        theme={theme}
        groups={groupValues ? [...new Set(chartGroupNames(groupValues))] : undefined}
        datedGroups={groupValues ? datedGroups(groupValues) : false}
        groupName={query.groupBy ? fieldLabel(query.groupBy.field) : null}
        rowFields={(query.pivot?.rows ?? []).map((row) => fieldLabel(row.field))}
        smallMultiples={Boolean(query.breakdown)}
        advanced={advanced}
        extra={visual === "kpi" ? <KeyFigureSettings query={query} onQuery={setQuery} format={format} onFormat={setFormat} part="style" /> : null}
      />
      {onSetDefault ? <p className={ui.muted}>A default for {VISUAL_NAMES[visual].toLowerCase()} charts is kept when you apply this chart or save the report.</p> : null}

      {formatOptionsFor(visual).axes || formatOptionsFor(visual).rules ? <label className={`${ui.checkbox} ${styles.advancedToggle}`}>
        <input type="checkbox" checked={advanced} onChange={(event) => setAdvanced(event.target.checked)} /> Show advanced settings
        <span className={ui.muted}> (reference lines, trend and projection, colour rules, gridlines, log scale)</span>
      </label> : null}
            </>
          ),
          interactions: (
            <>
      <ChartFormatPanel
        part="interactions"
        visual={visual}
        values={tileValueNames(query.measures)}
        format={format}
        onChange={setFormat}
        inherited={defaults?.[visual]}
        onSetDefault={onSetDefault ? (look) => onSetDefault(visual, look) : undefined}
        theme={theme}
      />
      {DRILLABLE.includes(visual) ? (
        <DrillSettings drill={drill} usable={drillUsable} query={query} columns={columns} onChange={(next) => {
          setDrill(next);
          // The first level is what the chart is grouped by.
          if (next && query.groupBy && (next.levels[0].field !== query.groupBy.field || next.levels[0].grain !== query.groupBy.grain)) setQuery({ ...query, groupBy: next.levels[0] });
        }} />
      ) : null}
      {DRILLABLE.includes(visual) && others.length ? (
        <fieldset className={styles.sizeFields}>
          <legend>When a group on this chart is clicked</legend>
          <p className={ui.muted}>Filter shows only that group&apos;s rows; Highlight fades the other groups on a chart grouped the same way (on any other it filters).</p>
          <div className={styles.propertyGrid}>
            {others.map((other) => (
              <Field key={other.id} label={other.title}>
                <select value={interactions[other.id] ?? "filter"} onChange={(event) => {
                  const next = { ...interactions };
                  if (event.target.value === "filter") delete next[other.id];
                  else next[other.id] = event.target.value as InteractionMode;
                  setInteractions(next);
                }}>
                  {INTERACTION_MODES.map((mode) => <option key={mode} value={mode}>{INTERACTION_LABELS[mode]}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </fieldset>
      ) : null}
      {visual === "pivot" ? <p className={ui.muted}>Clicking a number in the pivot table shows the rows behind it.</p> : null}
      {visual === "kpi" || visual === "table" ? <p className={ui.muted}>{visual === "kpi" ? "Key figures" : "Tables"} have no tooltips or clicks to set.</p> : null}
            </>
          ),
        }}
      />

      <div className={`${ui.rowButtons} ${styles.editorButtons}`}>
        <Button
          disabled={saving || !query.table || !preview?.result || Boolean(preview.error)}
          onClick={() =>
            onSave({
              id: tile?.id ?? `t${Date.now().toString(36)}`,
              title: title.trim() || query.measures[0]?.label || "Tile",
              visual,
              width,
              ...(height !== "medium" ? { height } : {}),
              query: { ...query, filters: query.filters.filter(filterComplete) },
              ...(format ? { format } : {}),
              ...(drillUsable && drill ? { drill } : {}),
              ...(DRILLABLE.includes(visual) && Object.keys(interactions).length ? { interactions } : {}),
              ...(tileDates && query.dateField ? { dates: tileDates } : {}),
            })
          }
        >
          {saving ? "Saving…" : tile ? "Apply changes" : "Add to report"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
        </fieldset>
      </aside>
    </section>
  );
}

