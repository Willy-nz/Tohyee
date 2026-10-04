import { describe, expect, it } from "vitest";
import { analyticsTileReference, parseAnalyticsTileReference } from "@/lib/dashboard/analytics-tile-reference";
import { DASHBOARD_PAGES, dashboardPage, defaultDashboardTileIds } from "@/lib/dashboard/pages";

describe("dashboard page registry", () => {
  it("keeps page names and default tile IDs together", () => {
    expect(DASHBOARD_PAGES.map(({ id, label }) => ({ id, label }))).toEqual([{ id: "home", label: "Home" }]);
    expect(defaultDashboardTileIds(dashboardPage("home")!)).toEqual(["cash_in_bank", "owed_to_you", "bills_to_pay", "next_gst_return"]);
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
