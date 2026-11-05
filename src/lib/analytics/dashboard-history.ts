import type { OrgTx } from "@/lib/db/org-transaction";

/*
 * A report's edit history (#591, decisions 1414-1415): each saved version
 * is kept with who saved it, how (in Tohyee, or "via AI key ..." / "via AI
 * app ..."), and what changed. A person puts an earlier version back from
 * the report's History; that's a new save, so it's in the history too.
 * Undo and Redo in the editor (decision 691) are still this session's own.
 */

/** The most versions kept for one report; older ones go as new ones are saved. */
export const MAX_HISTORY = 100;

export type DashboardDefinition = { name: string; description: string | null; settings: unknown; tiles: Array<{ id: string; title: string }> };

export type DashboardVersion = {
  version: number;
  savedByEmail: string;
  /** How it was saved when it wasn't in Tohyee itself, e.g. 'AI key "Claude"'. */
  savedVia: string | null;
  /** True when it was saved through an AI key or AI app. */
  byAi: boolean;
  change: string;
  savedAt: string;
  /** The version the report is now. */
  current: boolean;
};

/** Object keys in order and undefined left out, so the same definition always reads the same. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}
const json = (value: unknown) => JSON.stringify(stable(value ?? null));

/** "Sales, Costs and 2 more" */
function titles(list: string[]): string {
  const quoted = list.map((title) => `"${title}"`);
  if (quoted.length <= 3) return quoted.length === 2 ? `${quoted[0]} and ${quoted[1]}` : quoted.join(", ");
  return `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
}

/**
 * What a save changed, in a few words for the history: "Added "Sales by
 * month"; Moved tiles". `before` null: the report was made.
 */
export function describeChange(before: DashboardDefinition | null, after: DashboardDefinition): string {
  if (!before) {
    const count = after.tiles.length;
    return `Made the report${count ? ` with ${count} ${count === 1 ? "tile" : "tiles"}` : ""}`;
  }
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`Renamed to "${after.name}"`);
  if ((before.description ?? null) !== (after.description ?? null)) parts.push("Changed the description");
  const old = new Map(before.tiles.map((tile) => [tile.id, tile]));
  const now = new Map(after.tiles.map((tile) => [tile.id, tile]));
  const added = after.tiles.filter((tile) => !old.has(tile.id)).map((tile) => tile.title);
  const changed = after.tiles.filter((tile) => old.has(tile.id) && json(old.get(tile.id)) !== json(tile)).map((tile) => tile.title);
  const gone = before.tiles.filter((tile) => !now.has(tile.id)).map((tile) => tile.title);
  if (added.length) parts.push(`Added ${titles(added)}`);
  if (changed.length) parts.push(`Changed ${titles(changed)}`);
  if (gone.length) parts.push(`Took off ${titles(gone)}`);
  const keptBefore = before.tiles.filter((tile) => now.has(tile.id)).map((tile) => tile.id);
  const keptAfter = after.tiles.filter((tile) => old.has(tile.id)).map((tile) => tile.id);
  if (json(keptBefore) !== json(keptAfter)) parts.push("Moved tiles");
  if (json(before.settings) !== json(after.settings)) parts.push("Changed the report's dates, slicers or pages");
  const text = parts.length ? parts.join("; ") : "Saved with no changes";
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/** Keeps the version the report has just been saved as (call after the save, in the same transaction). */
export async function recordDashboardVersion(tx: OrgTx, dashboardId: string, change: string): Promise<void> {
  await tx.query(
    `insert into analytics_dashboard_history (dashboard_id, version, name, description, settings, tiles, saved_by_email, saved_via, change)
     select id, version, name, description, settings, tiles, $2, $3, $4 from analytics_dashboards where id = $1
     on conflict (dashboard_id, version) do nothing`,
    [dashboardId, tx.actor.email, tx.actor.via ?? null, change.slice(0, 500) || "Saved"],
  );
  await tx.query(
    `delete from analytics_dashboard_history where dashboard_id = $1 and version <= (
       select max(version) - $2 from analytics_dashboard_history where dashboard_id = $1)`,
    [dashboardId, MAX_HISTORY],
  );
}

type Row = { version: number; saved_by_email: string; saved_via: string | null; change: string; saved_at: Date };

/** The report's saved versions, newest first. The caller checks the person may see the report. */
export async function listDashboardVersions(tx: OrgTx, dashboardId: string, currentVersion: number): Promise<DashboardVersion[]> {
  const result = await tx.query<Row>(
    `select version, saved_by_email, saved_via, change, saved_at from analytics_dashboard_history
      where dashboard_id = $1 order by version desc`,
    [dashboardId],
  );
  return result.rows.map((row) => ({
    version: Number(row.version),
    savedByEmail: row.saved_by_email,
    savedVia: row.saved_via,
    byAi: typeof row.saved_via === "string" && row.saved_via.startsWith("AI "),
    change: row.change,
    savedAt: new Date(row.saved_at).toISOString(),
    current: Number(row.version) === currentVersion,
  }));
}

/** One saved version's definition, or null when it isn't kept. */
export async function dashboardVersionDefinition(tx: OrgTx, dashboardId: string, version: number): Promise<{ name: string; description: string | null; settings: Record<string, unknown>; tiles: unknown[] } | null> {
  const result = await tx.query<{ name: string; description: string | null; settings: Record<string, unknown>; tiles: unknown[] }>(
    "select name, description, settings, tiles from analytics_dashboard_history where dashboard_id = $1 and version = $2",
    [dashboardId, version],
  );
  return result.rows[0] ?? null;
}
