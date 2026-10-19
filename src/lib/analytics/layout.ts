import type { Tile } from "@/lib/analytics/dashboards";

/** Dashboard layout (#335, decision 596): pure steps the dashboard editor takes, so they can be tested. */

/** How much of a row a tile takes: a quarter, a third, a half, two-thirds or all of it. */
export const TILE_WIDTHS = ["quarter", "third", "half", "two-thirds", "full"] as const;
export type TileWidth = (typeof TILE_WIDTHS)[number];
export const TILE_HEIGHTS = ["small", "medium", "large"] as const;
export type TileHeight = (typeof TILE_HEIGHTS)[number];

export const WIDTH_LABELS: Record<TileWidth, string> = {
  quarter: "Quarter",
  third: "Third",
  half: "Half",
  "two-thirds": "Two-thirds",
  full: "Full",
};

export const HEIGHT_LABELS: Record<TileHeight, string> = { small: "Small", medium: "Medium", large: "Large" };

/** A chart's drawing height in pixels for each size. */
export const CHART_HEIGHTS: Record<TileHeight, number> = { small: 220, medium: 340, large: 480 };

/** Moves the tile at `from` so it ends up at `to` (both positions in the current list). */
export function moveTileTo(tiles: Tile[], from: number, to: number): Tile[] {
  if (from === to || from < 0 || from >= tiles.length) return tiles;
  const next = [...tiles];
  const [tile] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, tile);
  return next;
}

/** A copy of the tile straight after it, with a new id and "(copy)" on its title. */
export function duplicateTile(tiles: Tile[], index: number, id: string): Tile[] {
  const tile = tiles[index];
  if (!tile) return tiles;
  const title = `${tile.title} (copy)`.slice(0, 100);
  const copy: Tile = JSON.parse(JSON.stringify({ ...tile, id, title }));
  return [...tiles.slice(0, index + 1), copy, ...tiles.slice(index + 1)];
}

/** A text card's notes as paragraphs: a blank line starts a new one. */
export function paragraphs(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
