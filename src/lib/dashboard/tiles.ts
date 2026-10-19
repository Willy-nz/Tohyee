/**
 * Turning a page's tiles on and off and moving them (the farm Home's
 * Customise, FH7). Pure, so the screen and its tests share them.
 */

/** The tiles with `id` on (added at its place in `order`, else at the end) or off; a page keeps at least one. */
export function toggleTile(tiles: readonly string[], id: string, on: boolean, order: readonly string[], maxTiles: number): string[] {
  if (!on) {
    const next = tiles.filter((tile) => tile !== id);
    return next.length ? next : [...tiles];
  }
  if (tiles.includes(id) || tiles.length >= maxTiles) return [...tiles];
  const rank = order.indexOf(id);
  if (rank < 0) return [...tiles, id];
  // Before the first tile that comes after it in the page's own order.
  const before = tiles.findIndex((tile) => {
    const other = order.indexOf(tile);
    return other > rank;
  });
  const next = [...tiles];
  next.splice(before < 0 ? next.length : before, 0, id);
  return next;
}

/** The tiles with `id` moved one place earlier (-1) or later (1). */
export function moveTile(tiles: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = tiles.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= tiles.length) return [...tiles];
  const next = [...tiles];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
