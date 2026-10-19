import { describe, expect, it } from "vitest";
import { formatChartValue, toEChartsOption, type ChartSpec, type ChartTheme } from "@/lib/analytics/chart-spec";
import { showValue } from "@/lib/analytics/display";
import { changeMeasure, fieldLabel, isAutomaticLabel, measureLabel, tableLabel } from "@/lib/analytics/labels";
import type { Measure } from "@/lib/analytics/query";
import { formatCurrency } from "@/lib/format";

describe("negative money in Analytics (#328)", () => {
  it("puts the minus before the dollar sign, as the rest of Tohyee puts it first", () => {
    expect(formatCurrency("-27")).toBe("-$27.00");
    expect(formatCurrency("-700.00")).toBe("-$700.00");
    expect(formatCurrency("-1234567.891")).toBe("-$1,234,567.89");
    expect(formatCurrency("27.5")).toBe("$27.50");
    expect(formatCurrency("-0.001")).toBe("$0.00");
    expect(formatCurrency(null)).toBe("");
    expect(formatCurrency("n/a")).toBe("n/a");
  });

  it("shows table, key figure and pivot cells that way", () => {
    expect(showValue("-27.00", { format: "money" })).toBe("-$27.00");
    expect(showValue("27.00", { format: "money" })).toBe("$27.00");
    expect(showValue("-3.5000", { format: "number" })).toBe("-3.5");
    expect(showValue(null, { format: "money" })).toBe("");
  });

  const theme: ChartTheme = { text: "#000", mutedText: "#555", grid: "#ddd", background: "#fff", palette: ["#123456"] };
  const spec: ChartSpec = { kind: "column", category: "category", series: [{ field: "m0", label: "Amount" }], valueFormat: "money", currency: "NZD" };

  it("shows chart tooltips, axis labels and key figures that way", () => {
    const option = toEChartsOption(spec, [{ category: "Rent", m0: "-700.00" }], theme) as {
      tooltip: { valueFormatter: (value: number) => string };
      yAxis: Array<{ axisLabel: { formatter: (value: number) => string } }>;
    };
    expect(option.tooltip.valueFormatter(-27)).toBe("-$27.00");
    expect(option.yAxis[0].axisLabel.formatter(-1200)).toBe("-$1.2K");
    expect(formatChartValue("-27.00", { ...spec, kind: "kpi" })).toBe("-$27.00");
  });
});

describe("value labels that follow the column (#329)", () => {
  const measure = (patch: Partial<Measure>): Measure => ({ label: "", aggregate: "sum", ...patch });

  it("names a value from its calculation and column", () => {
    expect(measureLabel(measure({ field: "amount" }), "tohyee_ledger_lines")).toBe("Amount");
    expect(measureLabel(measure({ aggregate: "avg", field: "net" }), "tohyee_invoices")).toBe("Average net");
    expect(measureLabel(measure({ aggregate: "count" }), "tohyee_invoices")).toBe("Count of invoices");
    expect(measureLabel(measure({ aggregate: "count" }), "sales_2025")).toBe("Count of rows");
    expect(measureLabel(measure({ aggregate: "count_distinct", field: "contact" }), "tohyee_invoices")).toBe("Count of different contact");
    expect(measureLabel(measure({ field: "quantity", times: "unit_price" }), "tohyee_invoice_lines")).toBe("Quantity × unit price");
    expect(measureLabel(measure({ aggregate: "max", field: "gst" }), "tohyee_bills")).toBe("Largest GST");
  });

  it("follows a change of column or calculation while the label hasn't been typed", () => {
    // What a new chart starts with: the first money column's name.
    const start = measure({ label: "debit", field: "debit" });
    const amount = changeMeasure(start, { field: "amount" }, "tohyee_ledger_lines");
    expect(amount.label).toBe("Amount");
    const count = changeMeasure({ ...start, label: "contact id", field: "contact_id" }, { aggregate: "count" }, "tohyee_invoices");
    expect(count.label).toBe("Count of invoices");
    const fromRows = changeMeasure(measure({ label: "Rows", aggregate: "count" }), { aggregate: "sum", field: "net" }, "tohyee_invoices");
    expect(fromRows.label).toBe("Net");
    const fromBlank = changeMeasure(measure({ label: " ", field: "net" }), { aggregate: "avg" }, "tohyee_invoices");
    expect(fromBlank.label).toBe("Average net");
  });

  it("leaves a typed label alone", () => {
    const typed = changeMeasure(measure({ label: "Revenue", field: "amount" }), { field: "net" }, "tohyee_ledger_lines");
    expect(typed.label).toBe("Revenue");
    expect(typed.field).toBe("net");
    const typing = changeMeasure(measure({ label: "Amount", field: "amount" }), { label: "Amoun" }, "tohyee_ledger_lines");
    expect(typing.label).toBe("Amoun");
    expect(isAutomaticLabel("Sales", measure({ field: "net" }), "tohyee_invoices")).toBe(false);
  });

  it("tidies column and table names", () => {
    expect(fieldLabel("tracking_department")).toBe("Tracking department");
    expect(fieldLabel("contact_id")).toBe("Contact ID");
    expect(fieldLabel("gst")).toBe("GST");
    expect(tableLabel("tohyee_ledger_lines")).toBe("Ledger");
    expect(tableLabel("sales_2025")).toBe("Sales 2025");
  });
});
