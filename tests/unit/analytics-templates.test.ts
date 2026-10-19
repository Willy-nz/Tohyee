import { describe, expect, it } from "vitest";
import { buildTemplate, lastTwelveMonths, TEMPLATES } from "@/lib/analytics/templates";
import { parseTileQuery, type ColumnInfo } from "@/lib/analytics/query";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import { GA_REPORTS } from "@/lib/analytics/google-analytics-reports";

const cols = (spec: string): ColumnInfo[] => spec.split(" ").map((entry) => {
  const [name, type] = entry.split(":");
  return { name, type };
});

// The books copy's columns (src/lib/analytics/books.ts and farm.ts), as loaded.
const BOOKS = [
  { name: "tohyee_ledger_lines", columns: cols("journal_id:BIGINT posting_date:DATE source:VARCHAR account_code:VARCHAR account_name:VARCHAR account_class:VARCHAR account_type:VARCHAR contact:VARCHAR debit:DECIMAL(18,2) credit:DECIMAL(18,2) amount:DECIMAL(18,2) system_account:VARCHAR") },
  { name: "tohyee_invoices", columns: cols("invoice_id:BIGINT number:VARCHAR status:VARCHAR invoice_date:DATE due_date:DATE contact:VARCHAR net:DECIMAL(18,2) gst:DECIMAL(18,2) total:DECIMAL(18,2)") },
  { name: "tohyee_crm_opportunities", columns: cols("opportunity_id:BIGINT name:VARCHAR company:VARCHAR owner:VARCHAR amount:DECIMAL(18,2) expected_close:DATE stage:VARCHAR outcome:VARCHAR probability:INTEGER created_on:DATE") },
  { name: "tohyee_farm_pasture_readings", columns: cols("reading_id:BIGINT farm:VARCHAR paddock:VARCHAR measured_on:DATE cover_kg_dm_ha:INTEGER") },
  { name: "tohyee_farm_supplements", columns: cols("supplement_id:BIGINT paddock:VARCHAR fed_on:DATE feed:VARCHAR quantity:DECIMAL(18,2) kg_dm:DECIMAL(18,2)") },
  { name: "tohyee_farm_fertiliser_applications", columns: cols("application_id:BIGINT paddock:VARCHAR product:VARCHAR applied_on:DATE tonnes:DECIMAL(18,3)") },
  // Google Analytics' tables, for the Website template (decision 609).
  ...GA_REPORTS.map((report) => ({ name: report.table, columns: report.columns.map((column) => ({ name: column.name, type: column.type })) })),
];

describe("report templates (#337)", () => {
  it("dates a template over the last twelve whole months", () => {
    expect(lastTwelveMonths("2026-10-20")).toEqual({ from: "2025-11-01", to: "2026-10-31" });
    expect(lastTwelveMonths("2026-01-05")).toEqual({ from: "2025-02-01", to: "2026-01-31" });
  });

  it.each(TEMPLATES.map((template) => template.id))("builds the %s template from tiles that are all valid questions", (id) => {
    const built = buildTemplate(id, BOOKS, "2026-10-20")!;
    expect(built.tiles.length).toBeGreaterThan(3);
    const tables = new Map(BOOKS.map((table) => [table.name, table.columns]));
    for (const tile of built.tiles) {
      if (tile.query) expect(() => parseTileQuery(tile.query, tables), tile.title).not.toThrow();
      expect(() => parseChartFormat(tile.format), tile.title).not.toThrow();
      expect(tile.id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
    expect(new Set(built.tiles.map((tile) => tile.id)).size).toBe(built.tiles.length);
  });

  it("is offered only when its tables are loaded", () => {
    expect(buildTemplate("crm", BOOKS.filter((table) => table.name !== "tohyee_crm_opportunities"), "2026-10-20")).toBeNull();
    expect(buildTemplate("farm", BOOKS.slice(0, 3), "2026-10-20")).toBeNull();
  });
});
