"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "@/components/analytics/chart";
import { ChartFormatPanel } from "@/components/analytics/chart-format-panel";
import { KeyFigureView } from "@/components/analytics/key-figure";
import { KeyFigureSettings } from "@/components/analytics/key-figure-settings";
import { PinTileMenu } from "@/components/analytics/pin-tile-menu";
import { TileFilters } from "@/components/analytics/tile-filters";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { useModules } from "@/components/modules";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { ChartFormat } from "@/lib/analytics/chart-format";
import { tileChartSpec, tileValueNames } from "@/lib/analytics/tile-chart";
import type { Dashboard, DashboardSettings, Slicer, Tile } from "@/lib/analytics/dashboards";
import type {
  Aggregate,
  ColumnInfo,
  Grain,
  Measure,
  PivotColumn,
  PivotData,
  PivotDrillResult,
  PivotDrillSelection,
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
];

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { dashboard } = await api<{ dashboard: Dashboard }>("/api/analytics/dashboards", {
        method: "POST",
        body: { organisationId, name: name.trim() || "Untitled report", tiles: [] },
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
      {creating ? <Card title="Create a report" description="Start with a blank canvas, then add charts, scorecards and pivot tables from your connected data.">
        <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <Field label="Report name"><input autoFocus value={name} maxLength={100} placeholder="e.g. Sales and gross profit" onChange={(event) => setName(event.target.value)} /></Field>
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
        <div className={styles.reportThumbnail} aria-hidden="true">{report.tiles.length ? report.tiles.slice(0, 4).map((tile) => <span key={tile.id}>{VISUALS.find((visual) => visual.value === tile.visual)?.label ?? tile.visual}</span>) : <span>Blank report</span>}</div>
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
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [editing, setEditing] = useState(startEditing && can("bookkeeper"));
  const [sharing, setSharing] = useState(false);
  const [editingTile, setEditingTile] = useState<Tile | "new" | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dashboard = draft ?? loaded.data?.dashboard ?? null;
  const shown: Filters = filters ?? { from: dashboard?.settings.from ?? "", to: dashboard?.settings.to ?? "", preset: dashboard?.settings.preset ?? null, values: {} };
  const dates: DateContext = { today: loaded.data?.today ?? todayInBrowser(), financialYearEndMonth: loaded.data?.financialYearEndMonth ?? 3 };
  const canEdit = can("bookkeeper");

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

  function moveTile(index: number, by: number) {
    if (!dashboard) return;
    const tiles = [...dashboard.tiles];
    const [tile] = tiles.splice(index, 1);
    tiles.splice(Math.max(0, Math.min(tiles.length, index + by)), 0, tile);
    void save({ ...dashboard, tiles });
  }

  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!dashboard) return <p className={ui.muted}>Loading…</p>;

  return (
    <>
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
        onChange={setFilters}
        editing={editing}
        tables={tables.data?.tables ?? []}
        dates={dates}
        onSettings={(settings) => setDraft({ ...dashboard, settings })}
      />

      {sharing && canEdit ? <ShareCard organisationId={organisationId} dashboardId={dashboard.id} /> : null}

      {editingTile && canEdit ? (
        <TileEditor
          key={editingTile === "new" ? "new" : editingTile.id}
          saving={busy}
          organisationId={organisationId}
          tables={tables.data?.tables ?? []}
          tile={editingTile === "new" ? null : editingTile}
          filters={shown}
          onCancel={() => setEditingTile(null)}
          onSave={async (tile) => {
            const exists = dashboard.tiles.some((entry) => entry.id === tile.id);
            const tiles = exists ? dashboard.tiles.map((entry) => (entry.id === tile.id ? tile : entry)) : [...dashboard.tiles, tile];
            if (await save({ ...dashboard, tiles })) setEditingTile(null);
          }}
        />
      ) : null}

      {!editingTile && (dashboard.tiles.length === 0 ? (
        <Empty>{canEdit ? editing ? "Start your report with Add chart. Choose a source, a visual and the fields to show." : "This report is empty. Choose Edit to add a chart." : "No tiles yet."}</Empty>
      ) : (
        <div className={styles.grid}>
          {dashboard.tiles.map((tile, index) => (
            <section key={tile.id} className={tileClass(tile)}>
              <div className={styles.tileHeader}>
                <div>
                  <h2 className={tile.format?.card?.showTitle === false ? styles.visuallyHidden : styles.tileTitle}>{tile.title}</h2>
                  {tile.format?.card?.subtitle ? <p className={styles.tileSubtitle}>{tile.format.card.subtitle}</p> : null}
                </div>
                {editing ? (
                  <div className={styles.tileTools}>
                    <Button size="small" variant="secondary" aria-label={`Move ${tile.title} earlier`} onClick={() => moveTile(index, -1)} disabled={busy || index === 0}>
                      ↑
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      aria-label={`Move ${tile.title} later`}
                      onClick={() => moveTile(index, 1)}
                      disabled={busy || index === dashboard.tiles.length - 1}
                    >
                      ↓
                    </Button>
                    <Button size="small" variant="secondary" onClick={() => setEditingTile(tile)} disabled={busy}>
                      Edit
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
                ) : (
                  // Only saved tiles can be pinned, so not while the dashboard is being changed.
                  <PinTileMenu organisationId={organisationId} dashboardId={dashboard.id} tileId={tile.id} />
                )}
              </div>
              <TileBody organisationId={organisationId} dashboardId={dashboard.id} tile={tile} filters={shown} />
            </section>
          ))}
        </div>
      ))}
    </>
  );
}

function tileClass(tile: Tile): string {
  const card = tile.format?.card;
  return [
    styles.tile,
    tile.width === "full" ? styles.full : "",
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
function useTileResult(organisationId: string, query: TileQuery | null, filters: Filters, saved?: { dashboardId: string; tileId: string }) {
  const [state, setState] = useState<{ key: string; result: QueryResult | null; error: string | null } | null>(null);
  const key = JSON.stringify({ query, filters, saved });
  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const question = saved ? { dashboardId: saved.dashboardId, tileId: saved.tileId } : { query };
    api<QueryResult>("/api/analytics/query", {
      method: "POST",
      body: { organisationId, ...question, filters: { from: filters.from || null, to: filters.to || null, values: filters.values } },
    }).then(
      (result) => {
        if (!cancelled) setState({ key, result, error: null });
      },
      (error) => {
        if (!cancelled) setState({ key, result: null, error: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `key` covers query and filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organisationId, key]);
  return state?.key === key ? state : null;
}

function TileBody({ organisationId, dashboardId, tile, filters }: { organisationId: string; dashboardId: string; tile: Tile; filters: Filters }) {
  const state = useTileResult(organisationId, tile.query, filters, { dashboardId, tileId: tile.id });
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
          dashboardId,
          tileId: tile.id,
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
  tile: Pick<Tile, "title" | "visual" | "format">;
  result: QueryResult;
  onDrill?: (selection: PivotDrillSelection, title: string) => void;
  exportFor?: PivotExportFor;
}) {
  const measures = result.columns.filter((column) => column.role === "measure");
  const spec = useMemo(() => tileChartSpec(tile, measures), [tile, measures]);

  if (tile.visual === "pivot") {
    return result.pivot ? <PivotTable title={tile.title} pivot={result.pivot} onDrill={onDrill} exportFor={exportFor} /> : <Notice tone="error">This pivot table needs to be saved again.</Notice>;
  }
  if (result.rows.length === 0) return <Empty>Nothing matches.</Empty>;
  // Yes/No groups are named Yes and No on the chart too (decision 577).
  const yesNo = result.columns.some((column) => column.key === "category" && column.format === "boolean");
  const named = yesNo ? result.rows.map((row) => ({ ...row, category: row.category === null ? null : booleanText(row.category) })) : result.rows;
  const rows = tile.visual === "pie" || tile.visual === "donut" ? foldSlices(named, measures[0]?.key ?? "m0") : named;
  if (tile.visual === "kpi") return <KeyFigureView result={result} format={tile.format} />;
  if (!spec) {
    return (
      <div className={ui.tableWrap}>
        <table className={ui.table}>
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
                {result.columns.map((column) => (
                  <td key={column.key} className={column.role === "measure" ? ui.num : undefined}>
                    {showValue(row[column.key], column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.truncated ? <p className={ui.muted}>Showing the first 5,000 rows.</p> : null}
      </div>
    );
  }
  return <Chart spec={spec} rows={rows} />;
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
  return column.pivotValue === null ? "(blank)" : showValue(column.pivotValue, pivot.columnField);
}

/** The pivot as a report table for the existing CSV/Excel export (`/api/reports/export`), exact values kept as text. */
export function pivotExportTable(pivot: PivotData): ReportExportTable {
  const columns = [
    ...pivot.rowFields.map((field) => fieldLabel(field.label)),
    ...pivot.columns.map((column) =>
      [column.total ? "Grand total" : pivot.columnField ? `${fieldLabel(pivot.columnField.label)}: ${pivotColumnLabel(column, pivot)}` : "", column.measure.label]
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
}: {
  title: string;
  pivot: PivotData;
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
      { depth: row.depth, dimensions: row.dimensions, pivotValue: column.pivotValue, total: column.total },
      `Rows · ${drillTitle}`,
    );
  };
  return (
    <div className={styles.pivot}>
      {exportFor ? (
        <div className={styles.pivotTools}>
          <Button size="small" variant="secondary" disabled={exporting} onClick={() => void download("csv")}>Export CSV</Button>
          <Button size="small" variant="secondary" disabled={exporting} onClick={() => void download("xlsx")}>Export Excel</Button>
        </div>
      ) : null}
      {exportError ? <Notice tone="error">{exportError}</Notice> : null}
      <div className={`${ui.tableWrap} ${styles.pivotWrap}`}>
        <table className={ui.table} aria-label={`${title} pivot table`}>
          <caption>{title}</caption>
          <thead>
            {pivot.columnField ? (
              <>
                <tr>
                  {pivot.rowFields.map((field) => <th key={field.key} scope="col" rowSpan={2}>{fieldLabel(field.label)}</th>)}
                  {pivot.columnValues.map((value, index) => {
                    const column = pivot.columns.find((entry) => !entry.total && entry.pivotValue === value)!;
                    const count = pivot.columns.filter((entry) => !entry.total && entry.pivotValue === value).length;
                    return <th key={`column-${index}`} scope="colgroup" colSpan={count}>{fieldLabel(pivot.columnField!.label)}: {pivotColumnLabel(column, pivot)}</th>;
                  })}
                  {pivot.columns.some((column) => column.total) ? (
                    <th scope="colgroup" colSpan={pivot.columns.filter((column) => column.total).length}>Grand total</th>
                  ) : null}
                </tr>
                <tr>{pivot.columns.map((column) => <th key={column.key} scope="col" className={ui.num}>{column.measure.label}</th>)}</tr>
              </>
            ) : (
              <tr>
                {pivot.rowFields.map((field) => <th key={field.key} scope="col">{fieldLabel(field.label)}</th>)}
                {pivot.columns.map((column) => <th key={column.key} scope="col" className={ui.num}>{column.measure.label}</th>)}
              </tr>
            )}
          </thead>
          <tbody>
            {pivot.rows.map((row) => (
              <tr key={row.key} className={row.kind !== "detail" ? styles.pivotTotal : undefined}>
                {pivot.rowFields.map((field, index) => (
                  <th key={field.key} scope="row">{pivotRowLabel(row, index, field)}</th>
                ))}
                {pivot.columns.map((column) => (
                  <td key={column.key} className={ui.num}>
                    {onDrill ? (
                      <button
                        type="button"
                        className={styles.pivotCell}
                        aria-label={`Show rows for ${pivot.rowFields.map((field, index) => pivotRowLabel(row, index, field)).filter(Boolean).join(" · ")}, ${pivotColumnLabel(column, pivot)}, ${column.measure.label}`}
                        onClick={() => click(row, column)}
                      >
                        {showValue(row.cells[column.key] ?? null, column.measure)}
                      </button>
                    ) : (
                      showValue(row.cells[column.key] ?? null, column.measure)
                    )}
                  </td>
                ))}
              </tr>
            ))}
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

/** Adding or changing a tile, with a live preview. */
function TileEditor({
  saving,
  organisationId,
  tables,
  tile,
  filters,
  onSave,
  onCancel,
}: {
  saving: boolean;
  organisationId: string;
  tables: TableInfo[];
  tile: Tile | null;
  filters: Filters;
  onSave: (tile: Tile) => void;
  onCancel: () => void;
}) {
  const { can } = useWorkspace();
  const [fieldSearch, setFieldSearch] = useState("");
  const [title, setTitle] = useState(tile?.title ?? "");
  const [visual, setVisual] = useState<Visual>(tile?.visual ?? "column");
  const [width, setWidth] = useState<"half" | "full">(tile?.width ?? "half");
  const [query, setQuery] = useState<TileQuery>(tile?.query ?? blankQuery(tables[0]));
  const [format, setFormat] = useState<ChartFormat | undefined>(tile?.format);
  const table = tables.find((entry) => entry.name === query.table);
  const columns = table?.columns ?? [];
  const numbers = columns.filter((column) => isNumber(column.type));
  const groupType = columns.find((column) => column.name === query.groupBy?.field)?.type ?? "";
  const pivotRows = query.pivot?.rows ?? [];
  const usedPivotFields = new Set([...pivotRows.map((dimension) => dimension.field), ...(query.pivot?.column ? [query.pivot.column.field] : [])]);
  const preview = useTileResult(organisationId, query.table ? query : null, filters);

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
      <div className={styles.preview}>
        {!preview ? (
          <p className={ui.muted}>Working it out…</p>
        ) : preview.error ? (
          <Notice tone="error">{preview.error}</Notice>
        ) : (
          <TileResult tile={{ title: title || "Preview", visual, format }} result={preview.result!} />
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
        <Field label="Width">
          <select value={width} onChange={(event) => setWidth(event.target.value as "half" | "full")}>
            <option value="half">Half</option>
            <option value="full">Full</option>
          </select>
        </Field>
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
                      setQuery({ ...query, pivot: { rows, column: query.pivot?.column ?? null } });
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
                        setQuery({ ...query, pivot: { rows, column: query.pivot?.column ?? null } });
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
                  onClick={() => setQuery({ ...query, pivot: { rows: pivotRows.filter((_row, at) => at !== index), column: query.pivot?.column ?? null } })}
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
                    pivot: { rows: pivotRows, column: { ...query.pivot!.column!, grain: event.target.value as PivotGrain } },
                  })}
                >
                  {PIVOT_GRAINS.map((grain) => <option key={grain.value} value={grain.value}>{grain.label}</option>)}
                </select>
              </Field>
            ) : null}
          </>
        ) : (
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
          {measure.aggregate !== "count" ? (
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
      </div>

      <h3 className={styles.subheading}>Only include rows where</h3>
      <TileFilters organisationId={organisationId} table={query.table} columns={columns} filters={query.filters} onChange={(filters) => setQuery({ ...query, filters })} />

      {visual === "kpi" ? <KeyFigureSettings query={query} onQuery={setQuery} format={format} onFormat={setFormat} /> : null}

      <ChartFormatPanel visual={visual} values={tileValueNames(query.measures)} format={format} onChange={setFormat} />

      <div className={ui.rowButtons}>
        <Button
          disabled={saving || !query.table || !preview?.result || Boolean(preview.error)}
          onClick={() =>
            onSave({
              id: tile?.id ?? `t${Date.now().toString(36)}`,
              title: title.trim() || query.measures[0]?.label || "Tile",
              visual,
              width,
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
