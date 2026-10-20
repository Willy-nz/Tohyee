/**
 * The pages with a dashboard frame (decision 372), and so the pages an
 * Analytics tile can be pinned to (decision 374). Add Sales, Purchases,
 * Banking here when they get their frames.
 *
 * `cards` are every card a page offers in Customise; `defaultTiles` the
 * plain starting set. Who starts with which cards is worked out per person
 * by `defaultTilesFor` in `@/lib/dashboard/defaults` (decision 660).
 */
export const DASHBOARD_PAGES = [
  {
    id: "home",
    label: "Home",
    // Report viewers can't open Home, so they aren't offered it to pin to.
    minimumRole: "viewer",
    module: null,
    maxTiles: 4,
    cards: [
      { id: "cash_in_bank", label: "Cash in bank" },
      { id: "owed_to_you", label: "Money owed to you" },
      { id: "bills_to_pay", label: "Bills to pay" },
      { id: "next_gst_return", label: "Next GST return" },
      // Offered when there are jobs, and when the CRM is on (decision 662).
      { id: "jobs", label: "Jobs" },
      { id: "sales_pipeline", label: "Sales pipeline" },
    ],
    defaultTiles: [
      { id: "cash_in_bank", label: "Cash in bank" },
      { id: "owed_to_you", label: "Money owed to you" },
      { id: "bills_to_pay", label: "Bills to pay" },
      { id: "next_gst_return", label: "Next GST return" },
    ],
  },
  {
    // The farm Home (#341, FH1-FH11): Home for organisations with Farming on.
    id: "farm_home",
    label: "Farm home",
    minimumRole: "viewer",
    module: "farming",
    maxTiles: 10,
    cards: [
      { id: "farm_calendar", label: "This week on the farm" },
      { id: "catch_up", label: "Records to catch up on" },
      { id: "season_cash", label: "Cash this season" },
      { id: "stock", label: "Stock" },
      { id: "pasture", label: "Pasture and feed" },
      { id: "fertiliser", label: "Fertiliser" },
      { id: "performance", label: "Farm performance" },
      { id: "money", label: "Money" },
      { id: "notebook", label: "Farm notebook" },
    ],
    defaultTiles: [
      { id: "farm_calendar", label: "This week on the farm" },
      { id: "catch_up", label: "Records to catch up on" },
      { id: "season_cash", label: "Cash this season" },
      { id: "stock", label: "Stock" },
      { id: "pasture", label: "Pasture and feed" },
      { id: "fertiliser", label: "Fertiliser" },
      { id: "performance", label: "Farm performance" },
      { id: "money", label: "Money" },
      { id: "notebook", label: "Farm notebook" },
    ],
  },
  {
    // The CRM's Home, a sales dashboard (decision 662, SD1-SD6).
    id: "crm_home",
    label: "CRM home",
    minimumRole: "viewer",
    module: "crm",
    maxTiles: 8,
    cards: [
      { id: "next_actions", label: "Next actions" },
      { id: "pipeline", label: "Pipeline" },
      { id: "conversion", label: "Conversion" },
      { id: "my_opportunities", label: "My open opportunities" },
      { id: "my_tasks", label: "My tasks due" },
      { id: "recent_activities", label: "Recent activities" },
    ],
    defaultTiles: [
      { id: "pipeline", label: "Pipeline" },
      { id: "conversion", label: "Conversion" },
      { id: "next_actions", label: "Next actions" },
      { id: "my_opportunities", label: "My open opportunities" },
      { id: "my_tasks", label: "My tasks due" },
      { id: "recent_activities", label: "Recent activities" },
    ],
  },
] as const;

/** Home shows at most this many tiles, defaults and pinned together (each page says its own: `maxTiles`). */
export const MAX_DASHBOARD_TILES = 4;

export type DashboardPage = (typeof DASHBOARD_PAGES)[number];

export function dashboardPage(page: string): DashboardPage | undefined {
  return DASHBOARD_PAGES.find((entry) => entry.id === page);
}

/** The page's plain starting cards, before anything is known about the person (decision 660 picks per person). */
export function defaultDashboardTileIds(page: DashboardPage): readonly string[] {
  return page.defaultTiles.map((tile) => tile.id);
}

/** Every card the page offers in Customise. */
export function dashboardCardIds(page: DashboardPage): readonly string[] {
  return page.cards.map((tile) => tile.id);
}

/** The most tiles a page shows, its own and pinned together. */
export function maxTilesFor(page: DashboardPage): number {
  return page.maxTiles;
}
