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

/** How many of the grid's 12 columns each width takes (on a wide screen). */
export const WIDTH_SPANS: Record<TileWidth, number> = { quarter: 3, third: 4, half: 6, "two-thirds": 8, full: 12 };

/**
 * The tiles' rows on a wide screen, as the grid lays them out: each row
 * takes tiles in order until the next one doesn't fit (decision 752).
 */
export function layoutRows(tiles: Array<Pick<Tile, "width">>): number[][] {
  const rows: number[][] = [];
  let used = 12;
  tiles.forEach((tile, index) => {
    const span = WIDTH_SPANS[tile.width] ?? 6;
    if (used + span > 12) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1].push(index);
    used += span;
  });
  return rows;
}

/** The width that shares a row evenly between this many tiles, if there is one. */
export function evenWidth(count: number): TileWidth | null {
  return count === 1 ? "full" : count === 2 ? "half" : count === 3 ? "third" : count === 4 ? "quarter" : null;
}

export type ArrangeResult = { tiles: Tile[]; message: string } | { error: string };

function named(tiles: Tile[], ids: string[]): Tile[] {
  return [...new Set(ids)].map((id) => tiles.find((tile) => tile.id === id)).filter((tile): tile is Tile => Boolean(tile));
}

/** Gives the chosen tiles the first chosen tile's width or height (consistent sizing, decision 752). */
export function matchSize(tiles: Tile[], ids: string[], what: "width" | "height"): ArrangeResult {
  const chosen = named(tiles, ids);
  if (chosen.length < 2) return { error: "Choose two or more tiles." };
  const first = chosen[0];
  const wanted = new Set(chosen.map((tile) => tile.id));
  const next = tiles.map((tile) => {
    if (!wanted.has(tile.id) || tile.id === first.id) return tile;
    if (what === "width") return { ...tile, width: first.width };
    const copy = { ...tile };
    delete copy.height;
    return first.height ? { ...copy, height: first.height } : copy;
  });
  const size = what === "width" ? WIDTH_LABELS[first.width].toLowerCase() : HEIGHT_LABELS[first.height ?? "medium"].toLowerCase();
  return { tiles: next, message: `${chosen.length} tiles are now ${what === "width" ? `${size} width` : `${size} height`}, like ${first.title}.` };
}

/**
 * Shares one row evenly between the chosen tiles (distribute): two halves,
 * three thirds or four quarters, moved together after the first chosen
 * tile and given the tallest one's height so their tops and bottoms line up.
 */
export function shareRow(tiles: Tile[], ids: string[]): ArrangeResult {
  const chosen = named(tiles, ids).sort((a, b) => tiles.indexOf(a) - tiles.indexOf(b));
  const width = evenWidth(chosen.length);
  if (chosen.length < 2) return { error: "Choose two or more tiles." };
  if (!width) return { error: "A row can be shared by up to four tiles." };
  const order: TileHeight[] = ["small", "medium", "large"];
  const height = chosen.map((tile) => tile.height ?? "medium").sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  const wanted = new Set(chosen.map((tile) => tile.id));
  const resized = chosen.map((tile) => {
    const copy = { ...tile, width };
    delete copy.height;
    return height === "medium" ? copy : { ...copy, height };
  });
  const firstAt = tiles.findIndex((tile) => wanted.has(tile.id));
  const others = tiles.filter((tile) => !wanted.has(tile.id));
  const before = tiles.slice(0, firstAt).filter((tile) => !wanted.has(tile.id)).length;
  const next = [...others.slice(0, before), ...resized, ...others.slice(before)];
  return { tiles: next, message: `${chosen.length} tiles now share a row, ${WIDTH_LABELS[width].toLowerCase()} each.` };
}

/** Lines up each row's bottoms: every tile in a row with a chosen tile gets the row's tallest height (align). */
export function alignRowHeights(tiles: Tile[], ids: string[]): ArrangeResult {
  const order: TileHeight[] = ["small", "medium", "large"];
  const wanted = new Set(ids);
  const next = [...tiles];
  let changed = 0;
  for (const row of layoutRows(tiles)) {
    if (!row.some((index) => wanted.has(tiles[index].id))) continue;
    const tallest = row.map((index) => tiles[index].height ?? "medium").sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    for (const index of row) {
      if ((tiles[index].height ?? "medium") === tallest) continue;
      const copy = { ...tiles[index] };
      delete copy.height;
      next[index] = tallest === "medium" ? copy : { ...copy, height: tallest };
      changed += 1;
    }
  }
  if (!ids.length) return { error: "Choose a tile." };
  return { tiles: next, message: changed ? `${changed} ${changed === 1 ? "tile is" : "tiles are"} now as tall as the rest of ${changed === 1 ? "its" : "their"} row.` : "Those rows already line up." };
}
