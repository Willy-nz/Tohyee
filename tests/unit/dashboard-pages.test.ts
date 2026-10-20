import { describe, expect, it } from "vitest";
import { analyticsTileReference, parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { DASHBOARD_PAGES, dashboardPage, defaultDashboardTileIds } from "@/lib/dashboard/pages";

describe("dashboard page registry", () => {
  it("keeps page names and default tile IDs together", () => {
    expect(DASHBOARD_PAGES.map(({ id, label, maxTiles }) => ({ id, label, maxTiles }))).toEqual([
      { id: "home", label: "Home", maxTiles: 4 },
      { id: "farm_home", label: "Farm home", maxTiles: 10 },
      { id: "crm_home", label: "CRM home", maxTiles: 8 },
    ]);
    expect(defaultDashboardTileIds(dashboardPage("home")!)).toEqual(["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"]);
    expect(defaultDashboardTileIds(dashboardPage("farm_home")!)).toEqual(["farm_calendar", "catch_up", "season_cash", "stock", "pasture", "fertiliser", "performance", "money", "notebook"]);
    expect(defaultDashboardTileIds(dashboardPage("crm_home")!)).toEqual(["pipeline", "conversion", "next_actions", "my_opportunities", "my_tasks", "recent_activities"]);
    expect(dashboardPage("sales")).toBeUndefined();
  });

  it("round-trips saved Analytics tile references and rejects malformed ones", () => {
    const reference = analyticsTileReference("42", "sales-by-month");
    expect(reference).toBe("analytics:42:sales-by-month");
    expect(parseAnalyticsTileReference(reference)).toEqual({ dashboardId: "42", tileId: "sales-by-month" });
    expect(parseAnalyticsTileReference("analytics:../../42:tile")).toBeNull();
    expect(parseAnalyticsTileReference("analytics:42:bad_tile")).toBeNull();
  });
});
