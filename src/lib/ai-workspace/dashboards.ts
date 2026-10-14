import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { optionalString, requireArray, requireId, requireOneOf, requireString } from "@/lib/validation";
import { queryDataset, type QueryResult } from "./datasets";

/*
 * Dashboards over the AI's tables (example AIW7): a name and up to 12 tiles,
 * each a chart, number or table of one query on one table. The AI lays them
 * out; people see them in Tohyee. Every tile's query is run when the
 * dashboard is saved, so a broken tile is refused rather than saved.
 */

export const TILE_KINDS = ["column", "bar", "line", "area", "pie", "donut", "kpi", "table"] as const;
export type TileKind = (typeof TILE_KINDS)[number];

export type DashboardTile = {
  title: string;
  kind: TileKind;
  dataset: string;
  groupBy: unknown[];
  measures: unknown[];
  filters: unknown[];
  sort: unknown;
  limit: number;
  /** 1 = half width, 2 = full width. */
  width: 1 | 2;
  note?: string;
};

export type AiDashboard = { id: string; name: string; description: string | null; tiles: DashboardTile[]; createdByEmail: string; updatedAt: string };
export type DashboardWithData = AiDashboard & { results: Array<QueryResult | { error: string }> };

type Row = { id: string; name: string; description: string | null; tiles: DashboardTile[]; created_by_email: string; updated_at: string };
const COLUMNS = `id::text, name, description, tiles, created_by_email, to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at`;
const toDashboard = (row: Row): AiDashboard => ({ id: row.id, name: row.name, description: row.description, tiles: row.tiles, createdByEmail: row.created_by_email, updatedAt: row.updated_at });

function parseTiles(input: unknown): DashboardTile[] {
  const tiles = requireArray(input, "tiles", 12).map((raw, index): DashboardTile => {
    const tile = (raw ?? {}) as Record<string, unknown>;
    const kind = requireOneOf(tile.kind, `Tile ${index + 1}'s kind`, TILE_KINDS);
    const measures = Array.isArray(tile.measures) ? tile.measures : [];
    if (kind !== "table" && measures.length === 0) throw new ValidationError(`Tile ${index + 1}: a ${kind} needs at least one measure.`);
    if (kind !== "table" && kind !== "kpi" && (!Array.isArray(tile.groupBy) || tile.groupBy.length === 0)) {
      throw new ValidationError(`Tile ${index + 1}: a ${kind} chart needs a groupBy column for its categories.`);
    }
    const note = optionalString(tile.note, `Tile ${index + 1}'s note`, { maxLength: 500 });
    return {
      title: requireString(tile.title, `Tile ${index + 1}'s title`, { maxLength: 120 }),
      kind,
      dataset: requireString(tile.dataset, `Tile ${index + 1}'s table`, { maxLength: 63 }),
      groupBy: Array.isArray(tile.groupBy) ? tile.groupBy : [],
      measures,
      filters: Array.isArray(tile.filters) ? tile.filters : [],
      sort: tile.sort ?? null,
      limit: Math.min(Math.max(Number(tile.limit ?? 50) || 50, 1), 500),
      width: tile.width === 2 ? 2 : 1,
      ...(note ? { note } : {}),
    };
  });
  if (tiles.length === 0) throw new ValidationError("A dashboard needs at least one tile.");
  return tiles;
}

const runTile = (tx: OrgTx, tile: DashboardTile) =>
  queryDataset(tx, { name: tile.dataset, groupBy: tile.groupBy, measures: tile.measures, filters: tile.filters, sort: tile.sort, limit: tile.limit });

export async function listAiDashboards(tx: OrgTx): Promise<AiDashboard[]> {
  return (await tx.query<Row>(`select ${COLUMNS} from ai_dashboards where archived_at is null order by name`)).rows.map(toDashboard);
}

/** A dashboard with each tile's figures; a tile whose table has changed shows its error instead. */
export async function getAiDashboard(tx: OrgTx, idInput: unknown): Promise<DashboardWithData> {
  const id = requireId(idInput, "dashboardId");
  const row = (await tx.query<Row>(`select ${COLUMNS} from ai_dashboards where id = $1 and archived_at is null`, [id])).rows[0];
  if (!row) throw new NotFoundError("Dashboard not found.");
  const dashboard = toDashboard(row);
  const results: DashboardWithData["results"] = [];
  for (const tile of dashboard.tiles) {
    try {
      results.push(await runTile(tx, tile));
    } catch (error) {
      results.push({ error: error instanceof Error ? error.message : "This tile couldn't be worked out." });
    }
  }
  return { ...dashboard, results };
}

/** Makes a dashboard, or replaces one (`id`) (AIW7). Each tile's query must work. */
export async function saveAiDashboard(tx: OrgTx, input: { id?: unknown; name: unknown; description?: unknown; tiles: unknown }): Promise<DashboardWithData> {
  const name = requireString(input.name, "The dashboard's name", { maxLength: 120 });
  const description = optionalString(input.description, "description", { maxLength: 2000 });
  const tiles = parseTiles(input.tiles);
  for (const [index, tile] of tiles.entries()) {
    try {
      await runTile(tx, tile);
    } catch (error) {
      throw new ValidationError(`Tile ${index + 1} (${tile.title}): ${error instanceof Error ? error.message : "it doesn't work."}`);
    }
  }
  let id: string;
  if (input.id !== undefined && input.id !== null && input.id !== "") {
    id = requireId(input.id, "dashboardId");
    const updated = await tx.query("update ai_dashboards set name = $2, description = $3, tiles = $4::jsonb, updated_at = now() where id = $1 and archived_at is null", [
      id,
      name,
      description,
      JSON.stringify(tiles),
    ]);
    if (updated.rowCount === 0) throw new NotFoundError("Dashboard not found.");
  } else {
    const count = await tx.query<{ n: number }>("select count(*)::int as n from ai_dashboards where archived_at is null");
    if (count.rows[0].n >= 100) throw new ValidationError("There are already 100 dashboards. Archive some first.");
    id = (await tx.query<{ id: string }>("insert into ai_dashboards (name, description, tiles, created_by_email) values ($1, $2, $3::jsonb, $4) returning id::text", [name, description, JSON.stringify(tiles), tx.actor.email])).rows[0].id;
  }
  await writeAuditEvent(tx, { eventType: "ai_dashboard.saved", entityType: "ai_dashboard", entityId: id, details: { name, tiles: tiles.length } });
  return getAiDashboard(tx, id);
}

export async function archiveAiDashboard(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "dashboardId");
  const result = await tx.query("update ai_dashboards set archived_at = now() where id = $1 and archived_at is null", [id]);
  if (result.rowCount === 0) throw new NotFoundError("Dashboard not found.");
  await writeAuditEvent(tx, { eventType: "ai_dashboard.archived", entityType: "ai_dashboard", entityId: id, details: {} });
}
