import { writeAuditEvent } from "@/lib/audit";
import type { AiDashboard, DashboardTile } from "@/lib/ai-workspace/dashboards";
import { aiAnalyticsTable } from "@/lib/analytics/ai-tables";
import { createDashboard, type Dashboard } from "@/lib/analytics/dashboards";
import { fieldLabel } from "@/lib/analytics/labels";
import { tablesWithModel } from "@/lib/analytics/model";
import { parseTileQuery, type ColumnInfo } from "@/lib/analytics/query";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireId } from "@/lib/validation";

/*
 * "Move to Analytics" (#693, decision 1627): one of the AI's older
 * dashboards becomes an Analytics report over the same tables, which
 * Analytics has as `tohyee_ai_<name>`. Each tile keeps its title, chart,
 * grouping, values, filters, order and width. A tile Analytics can't show
 * the same way is left behind and named, never guessed at.
 */

export type LeftBehind = { title: string; why: string };
type Raw = Record<string, unknown>;

const OPS: Record<string, string> = { eq: "eq", ne: "neq", gt: "gt", gte: "gte", lt: "lt", lte: "lte", contains: "contains" };
const BREAKDOWN_KINDS = new Set(["column", "bar", "line", "area"]);

class CantMove extends Error {}

function measureLabel(measure: Raw): string {
  if (typeof measure.label === "string" && measure.label.trim()) return measure.label.trim().slice(0, 80);
  if (measure.aggregate === "count") return "Count";
  const field = fieldLabel(String(measure.field ?? ""));
  const words: Record<string, string> = { sum: field, avg: `Average ${field.toLowerCase()}`, min: `Smallest ${field.toLowerCase()}`, max: `Largest ${field.toLowerCase()}` };
  return words[String(measure.aggregate)] ?? field;
}

/** The old dashboard's own name for a value, which its sort refers to. */
function oldLabel(measure: Raw): string {
  if (typeof measure.label === "string" && measure.label) return measure.label;
  return measure.aggregate === "count" ? "count" : `${String(measure.aggregate)}_${String(measure.field)}`;
}

function group(raw: unknown): { field: string; grain?: string } {
  const entry = (typeof raw === "string" ? { field: raw } : (raw ?? {})) as Raw;
  return { field: String(entry.field ?? ""), ...(typeof entry.grain === "string" ? { grain: entry.grain } : {}) };
}

/** One old tile as an Analytics tile, or the reason it can't be one. */
export function convertTile(tile: DashboardTile, index: number): Raw {
  const table = aiAnalyticsTable(tile.dataset);
  if (!table) throw new CantMove(`its table's name (${tile.dataset}) is too long for Analytics.`);
  const groups = tile.groupBy.map(group);
  const measures = (tile.measures as Raw[]).map((measure) => ({
    label: measureLabel(measure),
    aggregate: String(measure.aggregate),
    ...(measure.aggregate === "count" ? {} : { field: String(measure.field ?? "") }),
  }));
  if (measures.length === 0) throw new CantMove("it lists the table's rows as they are; an Analytics table shows totals for each group.");
  if (new Set(measures.map((measure) => measure.label)).size !== measures.length) throw new CantMove("two of its values have the same name.");
  const filters = (tile.filters as Raw[]).map((filter) => {
    const op = OPS[String(filter.op)];
    if (!op) throw new CantMove(`its filter "${String(filter.op)}" has no match in Analytics.`);
    if (filter.value === null || filter.value === undefined) {
      if (op !== "eq" && op !== "neq") throw new CantMove("one of its filters compares with nothing.");
      return { field: String(filter.field ?? ""), op: op === "eq" ? "blank" : "not_blank", value: "" };
    }
    return { field: String(filter.field ?? ""), op, value: String(filter.value) };
  });
  const sortInput = (tile.sort ?? null) as { by?: unknown; direction?: unknown } | null;
  const direction = sortInput?.direction === "desc" ? "desc" : "asc";
  let sort: { by: "category" | "value"; direction: "asc" | "desc" } = { by: "category", direction: "asc" };
  if (sortInput?.by !== undefined) {
    const by = String(sortInput.by);
    const measureAt = (tile.measures as Raw[]).findIndex((measure) => oldLabel(measure) === by);
    if (measureAt > 0) throw new CantMove("it's sorted by its second value; Analytics sorts by the first.");
    if (measureAt === 0) sort = { by: "value", direction };
    else if (groups[0]?.field === by) sort = { by: "category", direction };
    else throw new CantMove("it's sorted by its second grouping.");
  }
  const base = { table, measures, filters, dateField: null };
  const common = {
    id: `moved-${index + 1}`,
    title: tile.title,
    // The old tile's note is the card's subtitle (200 characters).
    ...(tile.note ? { format: { card: { subtitle: tile.note.slice(0, 200) } } } : {}),
  };
  if (tile.kind === "kpi") {
    if (groups.length > 0) throw new CantMove("it's a key figure with a grouping.");
    return { ...common, visual: "kpi", width: "quarter", query: { ...base, groupBy: null } };
  }
  const width = tile.width === 2 ? "full" : "half";
  if (tile.kind === "table") {
    if (groups.length === 0) return { ...common, visual: "table", width, query: { ...base, groupBy: null } };
    if (groups.length === 1) return { ...common, visual: "table", width, query: { ...base, groupBy: groups[0], sort, limit: tile.limit } };
    // Two or three groupings: a pivot table's rows.
    if (sortInput?.by !== undefined || groups.some((entry) => entry.grain === "day")) throw new CantMove("it's a table grouped by more than one column with its own order.");
    return { ...common, visual: "pivot", width, query: { ...base, groupBy: null, pivot: { rows: groups, column: null } } };
  }
  if (groups.length === 0) throw new CantMove("it has nothing to group by.");
  if (groups.length > 2 || (groups.length === 2 && !BREAKDOWN_KINDS.has(tile.kind))) throw new CantMove(`a ${tile.kind} chart in Analytics has ${BREAKDOWN_KINDS.has(tile.kind) ? "up to two groupings" : "one grouping"}.`);
  if (groups.length === 2 && measures.length > 1) throw new CantMove("it splits more than one value by a second grouping.");
  return {
    ...common,
    visual: tile.kind,
    width,
    query: { ...base, groupBy: groups[0], ...(groups[1] ? { breakdown: groups[1] } : {}), sort, limit: tile.limit },
  };
}

/** Every tile that can move, checked against the tables Analytics has now, and the ones that can't. */
export function convertAiDashboard(dashboard: Pick<AiDashboard, "tiles">, tables: Map<string, ColumnInfo[]>): { tiles: Raw[]; left: LeftBehind[] } {
  const tiles: Raw[] = [];
  const left: LeftBehind[] = [];
  dashboard.tiles.forEach((tile, index) => {
    try {
      const converted = convertTile(tile, index);
      const table = (converted.query as { table: string }).table;
      if (!tables.has(table)) throw new CantMove(`its table (${tile.dataset}) isn't in Analytics yet. Refresh the books' copy on Analytics › Data sources, then move it again.`);
      parseTileQuery(converted.query, tables);
      tiles.push(converted);
    } catch (error) {
      if (!(error instanceof CantMove) && !(error instanceof ValidationError)) throw error;
      left.push({ title: tile.title, why: error.message });
    }
  });
  return { tiles, left };
}

/**
 * Makes the Analytics report. The old dashboard is archived only when every
 * tile moved; otherwise it stays, so nothing is lost from view.
 */
export async function moveAiDashboard(tx: OrgTx, idInput: unknown): Promise<{ dashboard: Dashboard; left: LeftBehind[]; archived: boolean }> {
  const id = requireId(idInput, "dashboardId");
  const row = (await tx.query<{ name: string; description: string | null; tiles: DashboardTile[] }>("select name, description, tiles from ai_dashboards where id = $1 and archived_at is null for update", [id])).rows[0];
  if (!row) throw new NotFoundError("Dashboard not found.");
  const { tiles, left } = convertAiDashboard(row, await tablesWithModel(tx));
  if (tiles.length === 0) throw new ValidationError(`None of its tiles can move yet. ${left.map((entry) => `${entry.title}: ${entry.why}`).join(" ")}`);
  const dashboard = await createDashboard(tx, { name: row.name, description: row.description ?? "", tiles });
  const archived = left.length === 0;
  if (archived) await tx.query("update ai_dashboards set archived_at = now() where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "ai_dashboard.moved_to_analytics", entityType: "ai_dashboard", entityId: id, details: { analyticsDashboardId: dashboard.id, tiles: tiles.length, left: left.length, archived } });
  return { dashboard, left, archived };
}
