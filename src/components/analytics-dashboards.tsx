"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useLeaveWarning } from "@/components/use-leave-warning";
import { copyName, hasUnsavedChanges, recordChange, redo, redoLabel, replaceSaved, startHistory, undo, undoLabel, type EditHistory } from "@/lib/analytics/edit-history";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { mergeFormats, pasteFormat, SECOND_GROUPING, SECOND_GROUPING_REQUIRED, VISUAL_NAMES, type ChartFormat, type DefaultableVisual, type VisualDefaults } from "@/lib/analytics/chart-format";
import { tileChartSpec, tileValueNames, tileWithDefaults } from "@/lib/analytics/tile-chart";
import { cardStyle, chartGroupNames, datedGroups } from "@/lib/analytics/chart-spec";
import { calendarHeight, calendarYears } from "@/lib/analytics/chart-relationships";
import { MAP_ATTRIBUTION, mapNote } from "@/lib/analytics/maps";
import { additiveValues } from "@/lib/analytics/small-multiples";
import { SmallMultiplesView } from "@/components/analytics/small-multiples";
import { useTileResult } from "@/components/analytics/use-tile-result";
import { ButtonItemView, ImageItemView, ItemEditor, ShapeItemView, TextItemView } from "@/components/analytics/items";
import { isItemVisual, type ButtonAction } from "@/lib/analytics/items";

/** Each small chart's height, by the tile's height. */
const MULTIPLE_HEIGHTS: Record<TileHeight, number> = { small: 160, medium: 200, large: 260 };
import type { ReportTheme } from "@/lib/charts/report-themes";
import { buildTemplate, TEMPLATES, type TemplateId } from "@/lib/analytics/templates";
import { todayIsoDate } from "@/lib/dates";
import type { Dashboard, DashboardSettings, Slicer, Tile } from "@/lib/analytics/dashboards";
import { CHART_HEIGHTS, HEIGHT_LABELS, TILE_HEIGHTS, TILE_WIDTHS, WIDTH_LABELS, duplicateTile, moveTileTo, type TileHeight, type TileWidth } from "@/lib/analytics/layout";
import type {
  Aggregate,
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
import { api, apiDownload, ApiError, errorMessage } from "@/lib/client/api";
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
type Filters = { from: string; to: string; preset?: DatePreset | null; values: Record<string, string[]> };
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
  // What the server has (the last save, or the report as loaded), and this
  // editing session's draft with its Undo and Redo (decisions 690-691).
  const [saved, setSaved] = useState<Dashboard | null>(null);
  const [history, setHistory] = useState<EditHistory<Dashboard> | null>(null);
  // Someone else saved first (decision 690): who and when, until Reload or Save a copy.
  const [conflict, setConflict] = useState<{ updatedByEmail: string; updatedAt: string } | null>(null);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = saved ?? loaded.data?.dashboard ?? null;
  const dashboard = history?.present ?? base;
  const unsaved = Boolean(base && dashboard && hasUnsavedChanges(base, dashboard));
  // Each saved tile's question, to tell which tiles in the draft are as saved.
  const savedQueries = useMemo(() => new Map((base?.tiles ?? []).map((tile) => [tile.id, JSON.stringify(tile.query)])), [base]);
  const shown: Filters = filters ?? { from: dashboard?.settings.from ?? "", to: dashboard?.settings.to ?? "", preset: dashboard?.settings.preset ?? null, values: {} };
  const dates: DateContext = { today: loaded.data?.today ?? todayInBrowser(), financialYearEndMonth: loaded.data?.financialYearEndMonth ?? 3 };
  const canEdit = can("bookkeeper");
  /**
   * What a report's buttons do (#376 phase 2, decision 686). Only resetting
   * the filters exists so far; pages and bookmarks (phase 3) add their
   * actions here and in BUTTON_ACTIONS.
   */
  const runButtonAction = (action: ButtonAction) => {
    if (action === "reset_filters") setFilters(null);
  };

  useLeaveWarning(unsaved, () =>
    confirm("Your changes to this report aren't saved. Leave without saving them?", { title: "Leave without saving?", confirmLabel: "Leave", danger: true }),
  );

  /** A change to the draft, named for Undo (e.g. "remove Sales by month"); `key` makes a run of the same change (typing) one step. */
  function change(next: Dashboard, label: string, key?: string) {
    if (!base) return;
    setHistory((current) => recordChange(current ?? startHistory(base), next, label, key));
  }

  const step = useCallback((direction: "undo" | "redo") => {
    setHistory((current) => (current ? (direction === "undo" ? undo(current) : redo(current)) : current));
  }, []);

  // Ctrl+Z / Cmd+Z and Ctrl+Shift+Z / Ctrl+Y while editing, except in a text box (which has its own Undo).
  useEffect(() => {
    if (!editing || editingTile) return;
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) step("undo");
      else if ((key === "z" && event.shiftKey) || key === "y") step("redo");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [editing, editingTile, step]);

  /**
   * Saves the draft, naming the version it started from (decision 690). A
   * save that fails, or is refused because someone else saved first, leaves
   * the draft as it is.
   */
  async function save(): Promise<boolean> {
    if (!dashboard || !base) return false;
    if (!unsaved) return true;
    const sent = dashboard;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const { dashboard: result } = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, {
        method: "PATCH",
        body: { organisationId, expectedVersion: base.version, name: sent.name, description: sent.description, settings: sent.settings, tiles: sent.tiles },
      });
      setSaved(result);
      setHistory((current) => (current ? replaceSaved(current, sent, result) : current));
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "dashboard_conflict") {
        setConflict({ updatedByEmail: String(caught.details?.updatedByEmail ?? "Someone"), updatedAt: String(caught.details?.updatedAt ?? "") });
      } else {
        setError(`${errorMessage(caught)} Your changes haven't been saved; they're still here, so you can try again.`);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The report as it's saved now, in place of the draft (after a conflict, or on starting to edit). */
  async function reloadSaved(ask: boolean) {
    if (ask && unsaved) {
      const ok = await confirm("Your changes will be replaced by the report as it's saved now. To keep them, save them as a copy first.", {
        title: "Reload the saved report?",
        confirmLabel: "Reload",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const { dashboard: fresh } = await api<{ dashboard: Dashboard }>(`/api/analytics/dashboards/${dashboardId}`, { query: { organisationId } });
      setSaved(fresh);
      setHistory(null);
      setConflict(null);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  /** The draft as a new report (after a conflict), so nobody's work is lost. It isn't shared with anyone yet. */
  async function saveCopy() {
    if (!dashboard) return;
    setBusy(true);
    setError(null);
    try {
      const { dashboard: copy } = await api<{ dashboard: Dashboard }>("/api/analytics/dashboards", {
        method: "POST",
        body: { organisationId, name: copyName(dashboard.name), description: dashboard.description, settings: dashboard.settings, tiles: dashboard.tiles },
      });
      setHistory(null);
      setConflict(null);
      router.push(`/analytics/dashboards/${copy.id}?edit=1`);
    } catch (caught) {
      setError(`${errorMessage(caught)} Your changes are still here.`);
    } finally {
      setBusy(false);
    }
  }

  async function beginEditing() {
    // Start from the latest save, so a report left open a while isn't a stale starting point.
    if (!history) await reloadSaved(false);
    setEditing(true);
  }

  async function remove() {
    if (!dashboard) return;
    const ok = await confirm(`Delete the ${dashboard.name} dashboard? The data it shows isn't touched.`, { title: "Delete dashboard?", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await api(`/api/analytics/dashboards/${dashboardId}`, { method: "DELETE", query: { organisationId } });
      setHistory(null);
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
    change({ ...dashboard, tiles }, `paste the format on ${tile.title}`);
  }

  /** Keeps (or with undefined, clears) the report's default look for a chart type. */
  function setVisualDefault(visual: DefaultableVisual, format: ChartFormat | undefined) {
    if (!dashboard) return;
    const defaults: VisualDefaults = { ...dashboard.settings.visualDefaults };
    if (format) defaults[visual] = format;
    else delete defaults[visual];
    const settings = { ...dashboard.settings };
    delete settings.visualDefaults;
    change(
      { ...dashboard, settings: Object.keys(defaults).length ? { ...settings, visualDefaults: defaults } : settings },
      format ? `set the default for ${VISUAL_NAMES[visual]}` : `reset the default for ${VISUAL_NAMES[visual]}`,
    );
  }

  function moveTile(index: number, to: number) {
    if (!dashboard) return;
    const tiles = moveTileTo(dashboard.tiles, index, to);
    if (tiles !== dashboard.tiles) change({ ...dashboard, tiles }, `move ${dashboard.tiles[index].title}`);
  }

  function putTile(tile: Tile) {
    if (!dashboard) return;
    const exists = dashboard.tiles.some((entry) => entry.id === tile.id);
    const tiles = exists ? dashboard.tiles.map((entry) => (entry.id === tile.id ? tile : entry)) : [...dashboard.tiles, tile];
    change({ ...dashboard, tiles }, exists ? `change ${tile.title}` : `add ${tile.title}`);
    setEditingTile(null);
  }

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!dashboard) return <p className={ui.muted}>Loading…</p>;
  const textTile = editingTile === "new-text" ? "new" : editingTile && editingTile !== "new" && isItemVisual(editingTile.visual) ? editingTile : null;
  const chartTile = textTile || editingTile === "new-text" ? null : editingTile;
  // The report's theme (decision 668) is scoped to its tiles and the editor's preview.
  const theme = reportTheme(dashboard.settings.theme, dashboard.customTheme);
  const themeScope = `report-theme-${dashboard.id}`;
  const themeClass = isTohyee(theme) ? themeScope : `${themeScope} ${styles.themed}`;

  return (
    <ReportThemeStyle theme={theme} scope={themeScope}>
      <div className={styles.header}>
        <div>
          {editing ? (
            <div className={ui.grid3}>
              <Field label="Name">
                <input value={dashboard.name} maxLength={100} onChange={(event) => change({ ...dashboard, name: event.target.value }, "rename the report", "name")} />
              </Field>
              <Field label="Description">
                <input value={dashboard.description ?? ""} maxLength={500} onChange={(event) => change({ ...dashboard, description: event.target.value }, "change the description", "description")} />
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
                variant="secondary"
                onClick={() => step("undo")}
                disabled={busy || Boolean(editingTile) || !history || !undoLabel(history)}
                aria-label={history && undoLabel(history) ? `Undo ${undoLabel(history)}` : "Undo"}
                title={history && undoLabel(history) ? `Undo ${undoLabel(history)} (Ctrl+Z)` : "Nothing to undo"}
              >
                Undo
              </Button>
              <Button
                variant="secondary"
                onClick={() => step("redo")}
                disabled={busy || Boolean(editingTile) || !history || !redoLabel(history)}
                aria-label={history && redoLabel(history) ? `Redo ${redoLabel(history)}` : "Redo"}
                title={history && redoLabel(history) ? `Redo ${redoLabel(history)} (Ctrl+Shift+Z)` : "Nothing to redo"}
              >
                Redo
              </Button>
              <Button onClick={() => void save()} disabled={busy || Boolean(editingTile) || !unsaved}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                onClick={async () => {
                  if (await save()) {
                    setEditing(false);
                    setEditingTile(null);
                  }
                }}
                disabled={busy || Boolean(editingTile)}
              >
                {unsaved ? "Save and view" : "View"}
              </Button>
              {unsaved ? (
                <Button variant="secondary" onClick={() => base && change(base, "discard the changes")} disabled={busy || Boolean(editingTile)}>
                  Discard changes
                </Button>
              ) : null}
              <Button variant="danger" onClick={() => void remove()} disabled={busy || Boolean(editingTile)}>
                Delete
              </Button>
            </>
          ) : canEdit ? (
            <Button variant="secondary" onClick={() => void beginEditing()}>
              Edit
            </Button>
          ) : null}
        </div>
      </div>
      {editing ? (
        <p className={styles.saveState} role="status" aria-live="polite">
          {busy ? "Saving…" : conflict || error ? "Not saved" : unsaved ? "Unsaved changes: Save to keep them. Viewers see the report as last saved." : "All changes saved"}
        </p>
      ) : null}
      {conflict ? (
        <Notice tone="error">
          <strong>Not saved.</strong> {conflict.updatedByEmail} saved this report{conflict.updatedAt ? ` at ${formatDateTime(conflict.updatedAt)}` : ""}, after you started changing it. Your changes
          are still here. Save them as a new report, or reload to see the saved version (your changes are then lost).
          <div className={`${ui.rowButtons} ${styles.conflictActions}`}>
            <Button size="small" onClick={() => void saveCopy()} disabled={busy}>Save mine as a copy</Button>
            <Button size="small" variant="secondary" onClick={() => void reloadSaved(true)} disabled={busy}>Reload the saved report</Button>
          </div>
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {editing && tables.error ? <Notice tone="error">{tables.error}</Notice> : null}
      {editing && tables.data?.tables.length === 0 ? <Notice tone="info">Connect and load a <Link href="/analytics/sources">data source</Link> to start adding charts.</Notice> : null}

      <FilterBar
        organisationId={organisationId}
        dashboardId={dashboard.id}
        settings={dashboard.settings}
        filters={shown}
        onChange={setFilters}
        editing={editing}
        tables={tables.data?.tables ?? []}
        dates={dates}
        onSettings={(settings) => change({ ...dashboard, settings }, "change the dates and slicers", "settings")}
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
            change({ ...dashboard, settings: choice ? { ...settings, theme: choice } : settings, customTheme: choice?.startsWith("custom:") ? chosen : null }, `choose the ${chosen.name} theme`);
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
          onSave={putTile}
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
          onCancel={() => setEditingTile(null)}
          onSave={putTile}
        />
      ) : null}

      {!editingTile && (dashboard.tiles.length === 0 ? (
        <Empty>{canEdit ? editing ? "Start your report with Add chart. Choose a source, a visual and the fields to show." : "This report is empty. Choose Edit to add a chart." : "No tiles yet."}</Empty>
      ) : (
        <div className={`${styles.grid} ${themeClass}`}>
          {dashboard.tiles.map((tile, index) => {
            // Drawn with the report's default for its chart type under its own settings (#376).
            const shownTile = tileWithDefaults(tile, dashboard.settings.visualDefaults);
            const look = cardStyle(shownTile.format);
            return (
            <section
              key={tile.id}
              style={look.card}
              className={`${tileClass(shownTile)} ${dropAt === index && dragging !== null && dragging !== index ? styles.dropTarget : ""} ${dragging === index ? styles.dragging : ""}`}
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
                </div>
                {editing ? (
                  <div className={styles.tileTools}>
                    <span className={styles.dragHandle} aria-hidden="true" title="Drag to move">⠿</span>
                    <Button size="small" variant="secondary" aria-label={`Move ${tile.title} earlier`} onClick={() => moveTile(index, index - 1)} disabled={busy || index === 0}>
                      ↑
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      aria-label={`Move ${tile.title} later`}
                      onClick={() => moveTile(index, index + 1)}
                      disabled={busy || index === dashboard.tiles.length - 1}
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
                      onClick={() => change({ ...dashboard, tiles: duplicateTile(dashboard.tiles, index, `t${Date.now().toString(36)}`) }, `duplicate ${tile.title}`)}
                      disabled={busy || dashboard.tiles.length >= 40}
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="small"
                      variant="danger"
                      aria-label={`Remove ${tile.title}`}
                      onClick={() => change({ ...dashboard, tiles: dashboard.tiles.filter((entry) => entry.id !== tile.id) }, `remove ${tile.title}`)}
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
                  <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={shownTile} filters={shown} asSaved={savedQueries.get(tile.id) === JSON.stringify(tile.query)} onAction={runButtonAction} />
                </div>
              ) : (
                <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={shownTile} filters={shown} asSaved={savedQueries.get(tile.id) === JSON.stringify(tile.query)} onAction={runButtonAction} />
              )}
            </section>
            );
          })}
        </div>
      ))}
    </ReportThemeStyle>
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
}: {
  organisationId: string;
  dashboardId: string;
  settings: DashboardSettings;
  filters: Filters;
  onChange: (filters: Filters) => void;
  editing: boolean;
  tables: TableInfo[];
  dates: DateContext;
  onSettings: (settings: DashboardSettings) => void;
}) {
  const [newSlicer, setNewSlicer] = useState("");
  // Slicers pick from columns with a few values: text and Yes/No, grouped by where they come from (decision 577).
  const slicerTables = tables
    .map((table) => ({ table, columns: table.columns.filter((column) => !isNumber(column.type) && !isDate(column.type)) }))
    .filter((entry) => entry.columns.length > 0);
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
      {settings.slicers.map((slicer) => (
        <SlicerControl
          key={`${slicer.table}.${slicer.field}`}
          organisationId={organisationId}
          dashboardId={dashboardId}
          slicer={slicer}
          chosen={filters.values[slicer.field] ?? []}
          onChange={(values) => onChange({ ...filters, values: { ...filters.values, [slicer.field]: values } })}
          onRemove={editing ? () => onSettings({ ...settings, slicers: settings.slicers.filter((entry) => entry !== slicer) }) : undefined}
        />
      ))}
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
              onSettings({ ...settings, slicers: [...settings.slicers, { table, field, label: fieldLabel(field) }] });
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

function SlicerControl({
  organisationId,
  dashboardId,
  slicer,
  chosen,
  onChange,
  onRemove,
}: {
  organisationId: string;
  dashboardId: string;
  slicer: Slicer;
  chosen: string[];
  onChange: (values: string[]) => void;
  onRemove?: () => void;
}) {
  const values = useApiData<{ values: string[]; type?: string }>("/api/analytics/values", { organisationId, dashboardId, table: slicer.table, field: slicer.field });
  // Yes/No columns show Yes and No; what's sent stays true and false (decision 577).
  const show = (value: string) => (values.data?.type === "BOOLEAN" ? booleanText(value) : value);
  const summary = chosen.length === 0 ? "All" : chosen.length === 1 ? show(chosen[0]) : `${chosen.length} chosen`;
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  // A click elsewhere or Escape closes the list. The listeners go when it closes, however it closes, and with
  // the page: before, closing it with its own button left one behind on the document for every opening (#330).
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menu.current) return;
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={styles.slicer}>
      <span className={styles.slicerLabel}>{slicer.label}</span>
      <details ref={menu} className={styles.slicerMenu} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{summary}</summary>
        <div className={styles.slicerList} role="group" aria-label={slicer.label}>
          {(values.data?.values ?? []).map((value) => (
            <label key={value} className={ui.checkbox}>
              <input
                type="checkbox"
                checked={chosen.includes(value)}
                onChange={(event) => onChange(event.target.checked ? [...chosen, value] : chosen.filter((entry) => entry !== value))}
              />{" "}
              {show(value)}
            </label>
          ))}
          {chosen.length ? (
            <Button size="small" variant="secondary" onClick={() => onChange([])}>
              Show all
            </Button>
          ) : null}
        </div>
      </details>
      {onRemove ? (
        <Button size="small" variant="danger" onClick={onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

/** A tile's answer: its saved question (`saved`, all a report viewer can run) or a question being built (`query`). */
/**
 * `asSaved`: the tile's question is the saved one, so it's run by the
 * report and tile (what report viewers can do). A tile added or changed in
 * the draft isn't saved yet, so its question is sent as it is.
 */
type TileBodyProps = { organisationId: string; dashboardId: string; tile: Tile; filters: Filters; asSaved: boolean; onAction?: (action: ButtonAction) => void };

function TileBody(props: TileBodyProps) {
  const { tile } = props;
  const height = CHART_HEIGHTS[tile.height ?? "small"];
  if (tile.visual === "text") return <TextItemView organisationId={props.organisationId} dashboardId={props.dashboardId} tile={tile} filters={props.filters} saved={props.asSaved} />;
  if (tile.visual === "image" && tile.image) return <ImageItemView organisationId={props.organisationId} dashboardId={props.dashboardId} image={tile.image} height={height} />;
  if (tile.visual === "shape" && tile.shape) return <ShapeItemView shape={tile.shape} height={height} />;
  if (tile.visual === "button" && tile.button) return <ButtonItemView button={tile.button} onAction={props.onAction} />;
  return <QueryTileBody {...props} />;
}

function QueryTileBody({ organisationId, dashboardId, tile, filters, asSaved }: TileBodyProps) {
  const state = useTileResult(organisationId, tile.query, filters, asSaved ? { dashboardId, tileId: tile.id } : undefined);
  const { current } = useWorkspace();
  const [opened, setDrill] = useState<{ title: string; result: PivotDrillResult; filtersKey: string } | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  // Rows opened under other dates or slicers no longer match the tile, so they're put away.
  const filtersKey = JSON.stringify(filters);
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
          ...(asSaved ? { dashboardId, tileId: tile.id } : { query: tile.query }),
          filters: { from: filters.from || null, to: filters.to || null, values: filters.values },
          drill: selection,
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

function TileResult({
  tile,
  result,
  onDrill,
  exportFor,
}: {
  tile: Pick<Tile, "title" | "visual" | "format" | "height"> & { query?: TileQuery | null };
  result: QueryResult;
  onDrill?: (selection: PivotDrillSelection, title: string) => void;
  exportFor?: PivotExportFor;
}) {
  const measures = result.columns.filter((column) => column.role === "measure");
  const spec = useMemo(() => tileChartSpec(tile, measures, { query: tile.query, truncated: result.truncated }), [tile, measures, result.truncated]);

  if (tile.visual === "pivot") {
    return result.pivot ? <PivotTable title={tile.title} pivot={result.pivot} onDrill={onDrill} exportFor={exportFor} format={tile.format} /> : <Notice tone="error">This pivot table needs to be saved again.</Notice>;
  }
  if (result.rows.length === 0) return <Empty>Nothing matches.</Empty>;
  // Yes/No groups are named Yes and No on the chart too (decision 577).
  const yesNo = result.columns.some((column) => column.key === "category" && column.format === "boolean");
  const named = yesNo ? result.rows.map((row) => ({ ...row, category: row.category === null ? null : booleanText(row.category) })) : result.rows;
  const rows = tile.visual === "pie" || tile.visual === "donut" ? foldSlices(named, measures[0]?.key ?? "m0") : named;
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
                    <td key={column.key}>{showValue(row[column.key], column)}</td>
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
        <Chart spec={spec} rows={rows} height={CHART_HEIGHTS[tile.height ?? "medium"]} />
        {note ? <p className={styles.mapNote}>{note}</p> : null}
        <p className={styles.mapNote}>{MAP_ATTRIBUTION}</p>
      </>
    );
  }
  // A calendar heat map is as tall as the years it shows (up to three).
  const height = tile.visual === "calendar"
    ? Math.max(CHART_HEIGHTS[tile.height ?? "medium"], calendarHeight(calendarYears(rows.map((row) => String(row.category ?? ""))).length))
    : CHART_HEIGHTS[tile.height ?? "medium"];
  return <Chart spec={spec} rows={rows} height={height} />;
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
}) {
  const { can } = useWorkspace();
  const [fieldSearch, setFieldSearch] = useState("");
  const [title, setTitle] = useState(tile?.title ?? "");
  const [visual, setVisual] = useState<Visual>(tile && !isItemVisual(tile.visual) ? tile.visual : "column");
  const [width, setWidth] = useState<TileWidth>(tile?.width ?? "half");
  const [height, setHeight] = useState<TileHeight>(tile?.height ?? "medium");
  const [query, setQuery] = useState<TileQuery>(tile?.query ?? blankQuery(tables[0]));
  const [format, setFormat] = useState<ChartFormat | undefined>(tile?.format);
  const [savedVersion, setSavedVersion] = useState(0);
  const table = tables.find((entry) => entry.name === query.table);
  const columns = table?.columns ?? [];
  const numbers = columns.filter((column) => isNumber(column.type));
  const groupType = columns.find((column) => column.name === query.groupBy?.field)?.type ?? "";
  const pivotRows = query.pivot?.rows ?? [];
  const subColumns = query.pivot?.subColumns ?? [];
  const usedPivotFields = new Set([...pivotRows.map((dimension) => dimension.field), ...(query.pivot?.column ? [query.pivot.column.field] : []), ...subColumns.map((dimension) => dimension.field)]);
  const preview = useTileResult(organisationId, query.table ? query : null, filters);
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
        <div className={styles.visualPicker} aria-label="Chart type">{VISUALS.map((entry) => <button type="button" key={entry.value} aria-pressed={visual === entry.value} onClick={() => changeVisual(entry.value)}>{entry.label}</button>)}</div>
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
        <Field label="Show as">
          <select value={visual} onChange={(event) => changeVisual(event.target.value as Visual)}>
            {VISUALS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </Field>
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

      {visual === "kpi" ? <KeyFigureSettings query={query} onQuery={setQuery} format={format} onFormat={setFormat} /> : null}

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
      />
      {onSetDefault ? <p className={ui.muted}>A default for {VISUAL_NAMES[visual].toLowerCase()} charts is kept when you apply this chart or save the report.</p> : null}

      <div className={ui.rowButtons}>
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

