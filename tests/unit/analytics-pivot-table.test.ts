import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PivotTable, pivotExportTable } from "@/components/analytics-dashboards";
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
    expect(html).not.toContain("<input");
    // No drill-down offered: values are plain text, not buttons.
    expect(html).not.toContain("<button");
  });

  it("offers each value as a keyboard-reachable button and the existing exports on a dashboard", () => {
    const html = renderToStaticMarkup(
      createElement(PivotTable, {
        title: "Sales pivot",
        pivot,
        onDrill: () => undefined,
        exportFor: { organisationId: "org", organisationName: "Org", filters: { from: "", to: "", values: {} } },
      }),
    );
    expect(html).toContain("Export CSV");
    expect(html).toContain("Export Excel");
    expect(html.match(/<button type="button"[^>]*aria-label="Show rows for /g)).toHaveLength(6);
  });

  it("exports exact decimal text, with subtotal and total rows marked", () => {
    const table = pivotExportTable(pivot);
    expect(table.columns).toEqual(["Region", "Product", "Channel: Web · Sales", "Grand total · Sales"]);
    expect(table.rows.map((row) => row.kind)).toEqual([undefined, "total", "total"]);
    expect(table.rows[0].cells).toEqual([
      { text: "Otago" },
      { text: "Widgets" },
      { text: "$0.30", value: "0.30", numeric: true },
      { text: "$0.30", value: "0.30", numeric: true },
    ]);
    expect(table.rows[1].cells.slice(0, 2)).toEqual([{ text: "Otago" }, { text: "Subtotal" }]);
    expect(table.rows[2].cells[0]).toEqual({ text: "Grand total" });
  });
});
