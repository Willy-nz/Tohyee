/*
 * The Farm app's bottom tabs on a phone (#447, #498 item 2, decisions 907
 * and 1111): Today · Map · Log · Safety · More, on every farm page (they
 * come from the farm pages' shared layout, so a direct link, a reload or a
 * page opened offline has them too), with the page's own tab marked.
 * Pure; tested in tests/unit/farm-nav.test.ts.
 */

export type FarmTab = "today" | "map" | "log" | "safety" | "more";

export const FARM_TABS: Array<{ key: FarmTab; label: string; href: string; icon: string }> = [
  { key: "today", label: "Today", href: "/operations/farm", icon: "◷" },
  { key: "map", label: "Map", href: "/operations/farm/map", icon: "▦" },
  { key: "log", label: "Log", href: "/operations/farm/log", icon: "+" },
  { key: "safety", label: "Safety", href: "/operations/farm/safety", icon: "⚠" },
  { key: "more", label: "More", href: "/operations/farm/more", icon: "≡" },
];

function under(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/** Which tab a farm page belongs to. Tractor mode is on the Map; Effluent and the other farm pages are under More. */
export function farmTabFor(pathname: string): FarmTab {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/operations/farm") return "today";
  if (under(path, "/operations/farm/map") || under(path, "/operations/farm/tractor")) return "map";
  if (under(path, "/operations/farm/log")) return "log";
  if (under(path, "/operations/farm/safety") || under(path, "/operations/farming/safety")) return "safety";
  return "more";
}

