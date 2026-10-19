/**
 * The pages with a dashboard frame (decision 372), and so the pages an
 * Analytics tile can be pinned to (decision 374). Add Sales, Purchases,
 * Banking and CRM home here when they get their frames.
 */
export const DASHBOARD_PAGES = [
  {
    id: "home",
    label: "Home",
    // Report viewers can't open Home, so they aren't offered it to pin to.
    minimumRole: "viewer",
    module: null,
    maxTiles: 4,
    defaultTiles: [
      { id: "cash_in_bank", label: "Cash in bank" },
      { id: "owed_to_you", label: "Money owed to you" },
      { id: "bills_to_pay", label: "Bills to pay" },
      { id: "next_gst_return", label: "Next GST return" },
    ],
  },
  {
    // The farm Home (#341, FH1-FH8): Home for organisations with Farming on.
    id: "farm_home",
    label: "Farm home",
    minimumRole: "viewer",
    module: "farming",
    maxTiles: 10,
    defaultTiles: [
      { id: "farm_calendar", label: "This week on the farm" },
      { id: "stock", label: "Stock" },
      { id: "pasture", label: "Pasture and feed" },
      { id: "fertiliser", label: "Fertiliser" },
      { id: "performance", label: "Farm performance" },
      { id: "money", label: "Money" },
      { id: "notebook", label: "Farm notebook" },
    ],
  },
] as const;

/** Home shows at most this many tiles, defaults and pinned together (each page says its own: `maxTiles`). */
export const MAX_DASHBOARD_TILES = 4;

export type DashboardPage = (typeof DASHBOARD_PAGES)[number];

export function dashboardPage(page: string): DashboardPage | undefined {
  return DASHBOARD_PAGES.find((entry) => entry.id === page);
}

export function defaultDashboardTileIds(page: DashboardPage): readonly string[] {
  return page.defaultTiles.map((tile) => tile.id);
}

/** The most tiles a page shows, its own and pinned together. */
export function maxTilesFor(page: DashboardPage): number {
  return page.maxTiles;
}
