import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { MAX_DASHBOARD_TILES } from "@/lib/dashboard/pages";
import { parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";

export type DashboardPreference = { hidden: boolean; tiles: string[] };

function parseTiles(raw: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = Array.from(new Set(raw.filter((value): value is string => typeof value === "string")));
  return unique.filter((value) => allowed.includes(value));
}

export async function getDashboardPreference(
  tx: OrgTx,
  input: { userId: string; page: string; defaultTiles: readonly string[]; allowedTiles?: readonly string[] },
): Promise<DashboardPreference> {
  const allowedTiles = input.allowedTiles ?? input.defaultTiles;
  const result = await tx.query<{ hidden: boolean; tiles: unknown }>(
    "select hidden, tiles from dashboard_preferences where user_id = $1 and page = $2",
    [input.userId, input.page],
  );
  const row = result.rows[0];
  if (!row) return { hidden: false, tiles: [...input.defaultTiles] };
  const tiles = parseTiles(row.tiles, allowedTiles);
  return { hidden: row.hidden, tiles: tiles.length > 0 ? tiles.slice(0, MAX_DASHBOARD_TILES) : [...input.defaultTiles] };
}

/** Most pins kept while hidden, so a saved row can't grow without end. */
const MAX_KEPT_HIDDEN = 8;

/**
 * Pins in the saved row that this person can't see right now (Analytics is
 * off, or the dashboard was unshared), with where they were. A save keeps
 * them, so turning Analytics back on or sharing again brings them back
 * (decision 378). Read again on every load, so they never show while hidden.
 */
async function hiddenPins(tx: OrgTx, stored: unknown, allowed: readonly string[]): Promise<Array<{ index: number; tile: string }>> {
  if (!Array.isArray(stored)) return [];
  const candidates: Array<{ index: number; tile: string; dashboardId: string; tileId: string }> = [];
  stored.forEach((tile, index) => {
    const parsed = typeof tile === "string" && !allowed.includes(tile) ? parseAnalyticsTileReference(tile) : null;
    if (parsed) candidates.push({ index, tile: tile as string, ...parsed });
  });
  if (candidates.length === 0) return [];
  // Only while the dashboard and its tile still exist: a deleted one's pin goes for good.
  const existing = await tx.query<{ id: string; tile_ids: string[] }>(
    `select id::text, array(select jsonb_array_elements(tiles) ->> 'id') as tile_ids
       from analytics_dashboards where id = any($1::bigint[])`,
    [[...new Set(candidates.map((candidate) => candidate.dashboardId))]],
  );
  const tilesOf = new Map(existing.rows.map((row) => [row.id, new Set(row.tile_ids)]));
  return candidates
    .filter((candidate) => tilesOf.get(candidate.dashboardId)?.has(candidate.tileId))
    .slice(0, MAX_KEPT_HIDDEN)
    .map(({ index, tile }) => ({ index, tile }));
}

export async function saveDashboardPreference(
  tx: OrgTx,
  input: {
    userId: string;
    page: string;
    hidden: unknown;
    tiles: unknown;
    defaultTiles: readonly string[];
    allowedTiles?: readonly string[];
  },
): Promise<DashboardPreference> {
  if (typeof input.hidden !== "boolean") throw new ValidationError("hidden must be true or false.");
  const allowedTiles = input.allowedTiles ?? input.defaultTiles;
  const tiles = parseTiles(input.tiles, allowedTiles).slice(0, MAX_DASHBOARD_TILES);
  if (tiles.length === 0) throw new ValidationError("Pick at least one tile.");
  const existing = await tx.query<{ tiles: unknown }>(
    "select tiles from dashboard_preferences where user_id = $1 and page = $2 for update",
    [input.userId, input.page],
  );
  // Hidden pins go back where they were; the page still only shows four.
  const stored = [...tiles];
  for (const { index, tile } of await hiddenPins(tx, existing.rows[0]?.tiles, allowedTiles)) {
    if (!stored.includes(tile)) stored.splice(Math.min(index, stored.length), 0, tile);
  }
  await tx.query(
    `insert into dashboard_preferences (user_id, page, hidden, tiles, updated_at)
          values ($1, $2, $3, $4::jsonb, now())
      on conflict (user_id, page) do update
            set hidden = excluded.hidden, tiles = excluded.tiles, updated_at = now()`,
    [input.userId, input.page, input.hidden, JSON.stringify(stored)],
  );
  return { hidden: input.hidden, tiles };
}
