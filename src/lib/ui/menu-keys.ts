/**
 * Which menu item gets focus after a key press in a "⋯" menu (WAI-ARIA menu
 * button pattern): arrows move and wrap, Home and End jump. Returns null for
 * keys the menu doesn't handle. Browser-safe.
 */
export function nextMenuIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
