import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { MAX_DASHBOARD_TILES } from "@/lib/dashboard/pages";

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
  await tx.query(
    `insert into dashboard_preferences (user_id, page, hidden, tiles, updated_at)
          values ($1, $2, $3, $4::jsonb, now())
      on conflict (user_id, page) do update
            set hidden = excluded.hidden, tiles = excluded.tiles, updated_at = now()`,
    [input.userId, input.page, input.hidden, JSON.stringify(tiles)],
  );
  return { hidden: input.hidden, tiles };
}
