/*
 * The screens that open with no connection (#472, #477, decision 1056):
 * the farm workspace, tractor mode, and the farm sections More links to,
 * so the information kept in an offline farm pack can be looked at. The
 * service worker saves each one after an online sign-in (public/sw-rules.js
 * has the same list: tests/unit/offline-sw.test.ts checks they match).
 * Browser-safe, no imports.
 */

export type OfflineScreen = { path: string; name: string };

export const OFFLINE_SCREENS: OfflineScreen[] = [
  { path: "/operations/farm", name: "Today" },
  { path: "/operations/farm/map", name: "Map" },
  { path: "/operations/farm/log", name: "Log" },
  { path: "/operations/farm/safety", name: "Safety" },
  { path: "/operations/farm/more", name: "More" },
  { path: "/operations/farm/offline", name: "Offline on this device" },
  { path: "/operations/farm/tractor", name: "Tractor mode" },
  { path: "/operations/farming", name: "Farms and paddocks" },
  { path: "/operations/farming/pasture", name: "Pasture and feed" },
  { path: "/operations/farming/soil", name: "Soil tests" },
  { path: "/operations/farming/calendar", name: "Farm calendar" },
  { path: "/operations/farming/fertiliser", name: "Fertiliser plans" },
  { path: "/operations/farming/notebook", name: "Farm notebook" },
];

/** The screens not yet saved on this device, from the service worker's list of saved pages. */
export function screensMissing(saved: string[]): OfflineScreen[] {
  const have = new Set(saved.map((path) => (path.length > 1 ? path.replace(/\/+$/, "") : path)));
  return OFFLINE_SCREENS.filter((screen) => !have.has(screen.path));
}
