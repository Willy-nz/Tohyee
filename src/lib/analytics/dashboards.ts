import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { listTables, runBuiltQuery } from "@/lib/analytics/engine";
import {
  buildPivotDrillSql,
  buildPivotSql,
  buildTileSql,
  type ColumnInfo,
  type DashboardFilters,
  MAX_PIVOT_DRILL_ROWS,
  MAX_PIVOT_CELLS,
  MAX_ROWS,
  parseTileQuery,
  type PivotColumn,
  type PivotDrillResult,
  type PivotDrillSelection,
  type PivotRow,
  type QueryResult,
  quoteIdentifier,
  type TileQuery,
  type Visual,
} from "@/lib/analytics/query";
import { requireAnalytics } from "@/lib/analytics/sources";

/** Analytics dashboards (step 3): tiles of questions about loaded tables. */

export type Tile = {
  id: string;
  title: string;
  visual: Visual;
  width: "half" | "full";
  query: TileQuery;
};

export type Slicer = { table: string; field: string; label: string };

export type DashboardSettings = {
  from: string | null;
  to: string | null;
  slicers: Slicer[];
};

export type Dashboard = {
  id: string;
  name: string;
  description: string | null;
  settings: DashboardSettings;
  tiles: Tile[];
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string;
  updatedAt: string;
};

const VISUALS: Visual[] = ["column", "bar", "line", "area", "combo", "pie", "donut", "kpi", "table", "pivot"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = {
  id: string;
  name: string;
  description: string | null;
  settings: Partial<DashboardSettings>;
  tiles: Tile[];
  created_by_email: string;
  created_at: Date;
  updated_by_email: string;
  updated_at: Date;
};

function toDashboard(row: Row): Dashboard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    settings: { from: row.settings.from ?? null, to: row.settings.to ?? null, slicers: row.settings.slicers ?? [] },
    tiles: row.tiles,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const COLUMNS = "id::text, name, description, settings, tiles, created_by_email, created_at, updated_by_email, updated_at";

/**
 * Who's looking: a report viewer (decision 360) sees only the dashboards
 * shared with them; everyone else in the organisation sees them all.
 */
export type DashboardReader = { userId: string | null; reportViewer: boolean };

const EVERYONE: DashboardReader = { userId: null, reportViewer: false };

export async function listDashboards(tx: OrgTx, reader: DashboardReader = EVERYONE): Promise<Dashboard[]> {
  const result = reader.reportViewer
    ? await tx.query<Row>(
        `select ${COLUMNS} from analytics_dashboards d
          where exists (select 1 from analytics_dashboard_shares s where s.dashboard_id = d.id and s.user_id = $1)
          order by name, id`,
        [reader.userId ?? ""],
      )
    : await tx.query<Row>(`select ${COLUMNS} from analytics_dashboards order by name, id`);
  return result.rows.map(toDashboard);
}

export async function getDashboard(tx: OrgTx, id: string, reader: DashboardReader = EVERYONE): Promise<Dashboard> {
  const dashboardId = /^\d{1,18}$/.test(id) ? id : "0";
  const result = await tx.query<Row>(`select ${COLUMNS} from analytics_dashboards where id = $1`, [dashboardId]);
  // Not shared reads as not found, so dashboards can't be probed.
  if (!result.rows[0]) throw new NotFoundError("That dashboard wasn't found.");
  if (reader.reportViewer) {
    const shared = await tx.query("select 1 from analytics_dashboard_shares where dashboard_id = $1 and user_id = $2", [dashboardId, reader.userId ?? ""]);
    if (shared.rows.length === 0) throw new NotFoundError("That dashboard wasn't found.");
  }
  return toDashboard(result.rows[0]);
}

/** The report viewers a dashboard is shared with (user ids). */
export async function dashboardShares(tx: OrgTx, id: string): Promise<string[]> {
  const dashboard = await getDashboard(tx, id);
  const result = await tx.query<{ user_id: string }>("select user_id from analytics_dashboard_shares where dashboard_id = $1 order by user_id", [dashboard.id]);
  return result.rows.map((row) => row.user_id);
}

/**
 * Shares a dashboard with exactly these people (replacing the list). Only
 * the organisation's report viewers can be chosen; everyone else already
 * sees every dashboard. `reportViewerIds` comes from the core database,
 * looked up before the transaction.
 */
export async function setDashboardShares(tx: OrgTx, id: string, input: unknown, reportViewerIds: ReadonlySet<string>): Promise<string[]> {
  await requireAnalytics(tx);
  const dashboard = await getDashboard(tx, id);
  if (!Array.isArray(input) || input.some((entry) => typeof entry !== "string")) throw new ValidationError("userIds must be a list.");
  const wanted = [...new Set(input as string[])];
  const stranger = wanted.find((userId) => !reportViewerIds.has(userId));
  if (stranger) throw new ValidationError("Dashboards can only be shared with this organisation's report viewers.");
  await tx.query("delete from analytics_dashboard_shares where dashboard_id = $1 and not (user_id = any($2::text[]))", [dashboard.id, wanted]);
  for (const userId of wanted) {
    await tx.query(
      `insert into analytics_dashboard_shares (dashboard_id, user_id, shared_by_email) values ($1, $2, $3)
       on conflict (dashboard_id, user_id) do nothing`,
      [dashboard.id, userId, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "analytics.dashboard_shared",
    entityType: "analytics_dashboard",
    entityId: dashboard.id,
    details: { name: dashboard.name, sharedWith: wanted.length },
  });
  return dashboardShares(tx, dashboard.id);
}

/**
 * The dashboard filters a reader may use. Report viewers can only slice by
 * the dashboard's own slicers, so they can't ask about other columns.
 */
export function allowedFilters(dashboard: Dashboard, filters: DashboardFilters, reader: DashboardReader): DashboardFilters {
  if (!reader.reportViewer) return filters;
  const slicerFields = new Set(dashboard.settings.slicers.map((slicer) => slicer.field));
  const values = Object.fromEntries(Object.entries(filters.values ?? {}).filter(([field]) => slicerFields.has(field)));
  return { from: filters.from, to: filters.to, values };
}

function parseSettings(input: unknown, tables: Map<string, ColumnInfo[]>): DashboardSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const date = (value: unknown, label: string) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !DATE.test(value)) throw new ValidationError(`${label} is YYYY-MM-DD.`);
    return value;
  };
  const slicers = (Array.isArray(raw.slicers) ? raw.slicers : []).map((entry, index): Slicer => {
    const slicer = (entry ?? {}) as Record<string, unknown>;
    const table = String(slicer.table ?? "");
    const field = String(slicer.field ?? "");
    if (!tables.get(table)?.some((column) => column.name === field)) {
      throw new ValidationError(`Slicer ${index + 1}: there's no column ${field} in ${table}.`);
    }
    const label = typeof slicer.label === "string" && slicer.label.trim() ? slicer.label.trim().slice(0, 60) : field;
    return { table, field, label };
  });
  if (slicers.length > 6) throw new ValidationError("A dashboard can have up to 6 slicers.");
  return { from: date(raw.from, "From"), to: date(raw.to, "To"), slicers };
}

function parseTiles(input: unknown, tables: Map<string, ColumnInfo[]>): Tile[] {
  if (!Array.isArray(input)) throw new ValidationError("tiles must be a list.");
  if (input.length > 24) throw new ValidationError("A dashboard can have up to 24 tiles.");
  return input.map((entry, index) => {
    const tile = (entry ?? {}) as Record<string, unknown>;
    const title = typeof tile.title === "string" && tile.title.trim() ? tile.title.trim().slice(0, 100) : `Tile ${index + 1}`;
    const visual = tile.visual as Visual;
    if (!VISUALS.includes(visual)) throw new ValidationError(`${title}: choose how to show it.`);
    let query: TileQuery;
    try {
      query = parseTileQuery(tile.query, tables);
    } catch (error) {
      throw new ValidationError(`${title}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (visual === "pivot" && !query.pivot) throw new ValidationError(`${title}: choose at least one pivot row field.`);
    if (visual !== "pivot" && query.pivot) throw new ValidationError(`${title}: pivot fields can only be used with a pivot table.`);
    if (visual !== "table" && visual !== "kpi" && visual !== "pivot" && !query.groupBy) throw new ValidationError(`${title}: a chart needs something to group by.`);
    if ((visual === "pie" || visual === "donut") && query.measures.length !== 1) throw new ValidationError(`${title}: a pie shows one value.`);
    return {
      id: typeof tile.id === "string" && /^[a-z0-9-]{1,40}$/.test(tile.id) ? tile.id : randomUUID(),
      title,
      visual,
      width: tile.width === "full" ? "full" : "half",
      query,
    };
  });
}

function parseName(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.trim().length > 100) throw new ValidationError("Give the dashboard a name (up to 100 characters).");
  return input.trim();
}

function parseDescription(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || input.length > 500) throw new ValidationError("The description can be up to 500 characters.");
  return input.trim() || null;
}

export async function createDashboard(tx: OrgTx, input: Record<string, unknown>): Promise<Dashboard> {
  await requireAnalytics(tx);
  const tables = await listTables(tx.organisationId);
  const name = parseName(input.name);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_dashboards (name, description, settings, tiles, created_by_email, updated_by_email)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $5) returning id::text`,
    [
      name,
      parseDescription(input.description),
      JSON.stringify(parseSettings(input.settings, tables)),
      JSON.stringify(parseTiles(input.tiles ?? [], tables)),
      tx.actor.email,
    ],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, { eventType: "analytics.dashboard_created", entityType: "analytics_dashboard", entityId: id, details: { name } });
  return getDashboard(tx, id);
}

export async function updateDashboard(tx: OrgTx, id: string, input: Record<string, unknown>): Promise<Dashboard> {
  await requireAnalytics(tx);
  const current = await getDashboard(tx, id);
  const tables = await listTables(tx.organisationId);
  const name = input.name === undefined ? current.name : parseName(input.name);
  const description = input.description === undefined ? current.description : parseDescription(input.description);
  const settings = input.settings === undefined ? current.settings : parseSettings(input.settings, tables);
  // Tiles are checked against the tables as they are now only when they're changed.
  const tiles = input.tiles === undefined ? current.tiles : parseTiles(input.tiles, tables);
  await tx.query(
    `update analytics_dashboards set name = $2, description = $3, settings = $4::jsonb, tiles = $5::jsonb,
            updated_by_email = $6, updated_at = now() where id = $1`,
    [current.id, name, description, JSON.stringify(settings), JSON.stringify(tiles), tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "analytics.dashboard_updated",
    entityType: "analytics_dashboard",
    entityId: current.id,
    details: { name, tiles: tiles.length },
  });
  return getDashboard(tx, current.id);
}

/** A dashboard tile's saved question, for reading the dashboard (what report viewers can run). */
export function tileOf(dashboard: Dashboard, tileId: unknown): Tile {
  const tile = dashboard.tiles.find((entry) => entry.id === tileId);
  if (!tile) throw new NotFoundError("That tile wasn't found.");
  return tile;
}

export async function deleteDashboard(tx: OrgTx, id: string): Promise<void> {
  await requireAnalytics(tx);
  const current = await getDashboard(tx, id);
  await tx.query("delete from analytics_dashboards where id = $1", [current.id]);
  await writeAuditEvent(tx, { eventType: "analytics.dashboard_deleted", entityType: "analytics_dashboard", entityId: current.id, details: { name: current.name } });
}

/** Works out one tile's answer. Run outside any PostgreSQL transaction. */
export async function runTile(organisationId: string, query: unknown, filters: DashboardFilters = {}): Promise<QueryResult> {
  const tables = await listTables(organisationId);
  const parsed = parseTileQuery(query, tables);
  if (parsed.pivot) {
    const built = buildPivotSql(parsed, tables.get(parsed.table)!, filters);
    const counts = await runBuiltQuery(organisationId, built.countSql, built.params);
    const rowCount = BigInt(counts[0]?.row_groups ?? "0");
    const columnCount = built.hasColumn ? BigInt(counts[0]?.column_groups ?? "0") + BigInt(1) : BigInt(1);
    if (rowCount * columnCount * BigInt(built.measures.length) > BigInt(MAX_PIVOT_CELLS)) {
      throw new ValidationError("Too many rows and columns; filter or group further");
    }
    const grouped = await runBuiltQuery(organisationId, built.sql, built.params);
    // The grand total row has every column value, already in column order.
    const columnValues = built.hasColumn
      ? grouped.filter((row) => row.gc === "0" && built.rowFields.every((_field, index) => row[`g${index}`] === "1")).map((row) => row.pivot_column)
      : [];
    const columns: PivotColumn[] = built.hasColumn
      ? [
          ...columnValues.flatMap((pivotValue, columnIndex) =>
            built.measures.map((measure, measureIndex) => ({
              key: `c${columnIndex}_m${measureIndex}`,
              label: pivotValue ?? "(blank)",
              pivotValue,
              measure,
              total: false,
            })),
          ),
          ...built.measures.map((measure, measureIndex) => ({
            key: `total_m${measureIndex}`,
            label: "Grand total",
            pivotValue: null,
            measure,
            total: true,
          })),
        ]
      : built.measures.map((measure) => ({ key: measure.key, label: measure.label, pivotValue: null, measure, total: false }));
    const rows = new Map<string, PivotRow>();
    for (const result of grouped) {
      const dimensions = built.rowFields.map((_field, index) => result[`r${index}`] ?? null);
      const depth = built.rowFields.filter((_field, index) => result[`g${index}`] === "0").length;
      const kind = depth === 0 ? "grand_total" : depth < built.rowFields.length ? "subtotal" : "detail";
      const key = JSON.stringify([depth, dimensions.slice(0, depth)]);
      let row = rows.get(key);
      if (!row) {
        row = { key, kind, depth, dimensions, cells: {} };
        rows.set(key, row);
      }
      for (let index = 0; index < built.measures.length; index += 1) {
        const measure = built.measures[index];
        const cellKey = built.hasColumn
          ? result.gc === "1"
            ? `total_m${index}`
            : `c${columnValues.indexOf(result.pivot_column)}_m${index}`
          : measure.key;
        row.cells[cellKey] = result[`m${index}`];
      }
    }
    return {
      columns: [...built.rowFields, ...built.measures],
      rows: [],
      truncated: false,
      pivot: { rowFields: built.rowFields, columnField: built.columnField, columnValues, columns, rows: [...rows.values()] },
    };
  }
  const built = buildTileSql(parsed, tables.get(parsed.table)!, filters);
  const rows = await runBuiltQuery(organisationId, built.sql, built.params);
  return { columns: built.columns, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

/** Drill into only the fields used by a saved pivot tile, never the source table itself. */
export async function runPivotDrilldown(
  organisationId: string,
  query: unknown,
  filters: DashboardFilters,
  selection: unknown,
): Promise<PivotDrillResult> {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new ValidationError("That pivot cell can't be opened.");
  const tables = await listTables(organisationId);
  const parsed = parseTileQuery(query, tables);
  const built = buildPivotDrillSql(parsed, tables.get(parsed.table)!, filters, selection as PivotDrillSelection);
  const rows = await runBuiltQuery(organisationId, built.sql, built.params);
  return { columns: built.columns, rows: rows.slice(0, MAX_PIVOT_DRILL_ROWS), truncated: rows.length > MAX_PIVOT_DRILL_ROWS };
}

/** The values a slicer offers: up to 500 distinct values of a column, sorted. */
export async function sliceValues(organisationId: string, table: string, field: string): Promise<string[]> {
  const tables = await listTables(organisationId);
  if (!tables.get(table)?.some((column) => column.name === field)) throw new ValidationError(`There's no column ${field} in ${table}.`);
  const rows = await runBuiltQuery(
    organisationId,
    `select distinct cast(${quoteIdentifier(field)} as VARCHAR) as value from ${quoteIdentifier(table)} where ${quoteIdentifier(field)} is not null order by 1 limit 500`,
    [],
  );
  return rows.map((row) => row.value ?? "");
}

/** The loaded tables and their columns, for building tiles. */
export async function describeTables(organisationId: string): Promise<Array<{ name: string; columns: ColumnInfo[] }>> {
  const tables = await listTables(organisationId);
  return [...tables.entries()].map(([name, columns]) => ({ name, columns }));
}
