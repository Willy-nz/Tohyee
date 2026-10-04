export const DASHBOARD_PAGES = [
  {
    id: "home",
    label: "Home",
    defaultTiles: [
      { id: "cash_in_bank", label: "Cash in bank" },
      { id: "owed_to_you", label: "Money owed to you" },
      { id: "bills_to_pay", label: "Bills to pay" },
      { id: "next_gst_return", label: "Next GST return" },
    ],
  },
] as const;

export type DashboardPage = (typeof DASHBOARD_PAGES)[number];

export function dashboardPage(page: string): DashboardPage | undefined {
  return DASHBOARD_PAGES.find((entry) => entry.id === page);
}

export function defaultDashboardTileIds(page: DashboardPage): readonly string[] {
  return page.defaultTiles.map((tile) => tile.id);
}
