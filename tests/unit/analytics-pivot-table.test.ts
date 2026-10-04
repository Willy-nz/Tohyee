import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PivotTable } from "@/components/analytics-dashboards";
import type { PivotData } from "@/lib/analytics/query";

const pivot: PivotData = {
  rowFields: [
    { key: "r0", label: "region", format: "text", role: "category" },
    { key: "r1", label: "product", format: "text", role: "category" },
  ],
  columnField: { key: "pivot_column", label: "channel", format: "text", role: "category" },
  columnValues: ["Web"],
  columns: [
    {
      key: "c0_m0",
      label: "Web",
      pivotValue: "Web",
      measure: { key: "m0", label: "Sales", format: "money", role: "measure" },
      total: false,
    },
    {
      key: "total_m0",
      label: "Grand total",
      pivotValue: null,
      measure: { key: "m0", label: "Sales", format: "money", role: "measure" },
      total: true,
    },
  ],
  rows: [
    { key: "detail", kind: "detail", depth: 2, dimensions: ["Otago", "Widgets"], cells: { c0_m0: "0.30", total_m0: "0.30" } },
    { key: "subtotal", kind: "subtotal", depth: 1, dimensions: ["Otago", null], cells: { c0_m0: "0.30", total_m0: "0.30" } },
    { key: "grand", kind: "grand_total", depth: 0, dimensions: [null, null], cells: { c0_m0: "0.30", total_m0: "0.30" } },
  ],
};

describe("analytics pivot table", () => {
  it("renders an accessible, read-only table with totals and exports", () => {
    const html = renderToStaticMarkup(createElement(PivotTable, { title: "Sales pivot", pivot }));

    expect(html).toMatch(/<table[^>]*aria-label="Sales pivot pivot table"/);
    expect(html).toContain("<caption>Sales pivot</caption>");
    expect(html).toContain('scope="colgroup"');
    expect(html).toContain('scope="row"');
    expect(html).toContain("Subtotal");
    expect(html).toContain("Grand total");
    expect(html).toContain("Channel: Web");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Export Excel");
    expect(html).not.toContain("<input");
  });
});
