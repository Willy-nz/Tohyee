import { describe, expect, it } from "vitest";
import { analyticsWords } from "@/lib/ai/mcp-server";
import { describeChange } from "@/lib/analytics/dashboard-history";

/** What a save changed, for a report's edit history (#591, decision 1414). */
describe("describeChange", () => {
  const tile = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, ...extra });
  const report = (tiles: Array<{ id: string; title: string }>, more: Record<string, unknown> = {}) => ({ name: "Sales", description: null, settings: { preset: null, slicers: [] }, tiles, ...more });

  it("names a new report, and each kind of change in a save", () => {
    expect(describeChange(null, report([tile("a", "Sales")]))).toBe("Made the report with 1 tile");
    expect(describeChange(null, report([]))).toBe("Made the report");
    const before = report([tile("a", "Sales"), tile("b", "Costs"), tile("c", "Orders")]);
    expect(describeChange(before, report([tile("b", "Costs"), tile("a", "Sales"), tile("c", "Orders")]))).toBe("Moved tiles");
    expect(describeChange(before, report([tile("a", "Sales", { width: "full" }), tile("c", "Orders"), tile("d", "Margin")], { name: "Sales 2026" }))).toBe(
      'Renamed to "Sales 2026"; Added "Margin"; Changed "Sales"; Took off "Costs"',
    );
    expect(describeChange(before, report(before.tiles, { settings: { slicers: [], preset: null } }))).toBe("Saved with no changes");
    expect(describeChange(before, report(before.tiles, { settings: { preset: "this_month", slicers: [] } }))).toBe("Changed the report's dates, slicers or pages");
    const many = report(["w", "x", "y", "z"].map((id) => tile(id, id.toUpperCase())));
    expect(describeChange(report([]), many)).toBe('Added "W", "X" and 2 more');
  });

  it("the AI is told it can build reports only when the tools are offered", () => {
    expect(analyticsWords(["list_invoices"])).toBe("");
    expect(analyticsWords(["list_analytics_tables", "list_analytics_dashboards"])).not.toContain("build Analytics reports");
    expect(analyticsWords(["list_analytics_tables", "create_analytics_dashboard"])).toContain("You can build Analytics reports yourself");
  });
});
