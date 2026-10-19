import { describe, expect, it } from "vitest";
import {
  GA_REPORTS,
  GA_TABLE_PREFIX,
  gaDate,
  gaHistoryStart,
  gaNumber,
  gaReportRequest,
  gaRows,
  gaTableColumns,
  isGaTable,
} from "@/lib/analytics/google-analytics-reports";
import { buildTemplate } from "@/lib/analytics/templates";
import { tableDescription, tableLabel, tableNoun } from "@/lib/analytics/labels";
import { parseTileQuery } from "@/lib/analytics/query";
import { parseChartFormat } from "@/lib/analytics/chart-format";

const daily = GA_REPORTS.find((report) => report.table === "google_analytics_daily")!;
const traffic = GA_REPORTS.find((report) => report.table === "google_analytics_traffic")!;

/** Examples GA3-GA5 in docs/ACCOUNTING-EXAMPLES.md (Google Analytics website data, not yet reviewed). Made-up figures. */
describe("Google Analytics reports to tables (decision 607)", () => {
  it("GA3 asks Google for each report's GA4 dimensions and metrics, by day, a page at a time", () => {
    expect(gaReportRequest(daily, "2025-10-01", 0)).toEqual({
      dateRanges: [{ startDate: "2025-10-01", endDate: "today" }],
      dimensions: [{ name: "date" }],
      metrics: ["activeUsers", "newUsers", "sessions", "engagedSessions", "screenPageViews", "engagementRate", "keyEvents", "totalRevenue"].map((name) => ({ name })),
      orderBys: [{ dimension: { dimensionName: "date" } }],
      keepEmptyRows: false,
      offset: "0",
      limit: "50000",
    });
    const second = gaReportRequest(traffic, "2025-10-01", 50_000);
    expect(second.dimensions.map((dimension) => dimension.name)).toEqual(["date", "sessionDefaultChannelGroup", "sessionSource", "sessionMedium"]);
    expect(second.orderBys).toHaveLength(4);
    expect(second.offset).toBe("50000");
    // Google allows at most 9 dimensions and 10 metrics in a request.
    for (const report of GA_REPORTS) {
      const request = gaReportRequest(report, "2025-10-01", 0);
      expect(request.dimensions.length, report.table).toBeLessThanOrEqual(9);
      expect(request.metrics.length, report.table).toBeLessThanOrEqual(10);
      expect(report.columns[0], report.table).toEqual({ name: "date", type: "DATE", dimension: "date" });
      expect(report.table.startsWith(GA_TABLE_PREFIX)).toBe(true);
    }
    // Nothing still asks for the old "conversions" metric (renamed keyEvents, May 2024).
    expect(JSON.stringify(GA_REPORTS)).not.toContain('"conversions"');
  });

  it("GA4 turns Google's rows into table rows, matching columns by header and keeping decimals exact", () => {
    const response = {
      // Google's headers in a different order from the request: matched by name.
      dimensionHeaders: [{ name: "date" }],
      metricHeaders: ["totalRevenue", "keyEvents", "engagementRate", "screenPageViews", "engagedSessions", "sessions", "newUsers", "activeUsers"].map((name) => ({ name })),
      rows: [
        { dimensionValues: [{ value: "20261001" }], metricValues: ["129.955", "2", "0.6666666666666666", "212", "40", "60", "31", "48"].map((value) => ({ value })) },
        { dimensionValues: [{ value: "20261002" }], metricValues: ["0", "0.5", "1.5E-5", "9", "1", "3", "3", "3"].map((value) => ({ value })) },
      ],
      rowCount: 2,
      metadata: { currencyCode: "NZD", timeZone: "Pacific/Auckland" },
    };
    expect(gaRows(daily, response)).toEqual([
      ["2026-10-01", "48", "31", "60", "40", "212", "0.666667", "2.00", "129.96"],
      ["2026-10-02", "3", "3", "3", "1", "9", "0.000015", "0.50", "0.00"],
    ]);
    expect(gaTableColumns(daily)).toEqual([
      { name: "date", type: "DATE" },
      { name: "active_users", type: "BIGINT" },
      { name: "new_users", type: "BIGINT" },
      { name: "sessions", type: "BIGINT" },
      { name: "engaged_sessions", type: "BIGINT" },
      { name: "page_views", type: "BIGINT" },
      { name: "engagement_rate", type: "DECIMAL(18,6)" },
      { name: "key_events", type: "DECIMAL(18,2)" },
      { name: "revenue", type: "DECIMAL(18,2)" },
    ]);
    // Text dimensions come as Google sends them, "(not set)" included; an empty answer has no rows.
    const sources = gaRows(traffic, {
      dimensionHeaders: ["date", "sessionDefaultChannelGroup", "sessionSource", "sessionMedium"].map((name) => ({ name })),
      metricHeaders: ["sessions", "activeUsers", "engagedSessions", "keyEvents", "totalRevenue"].map((name) => ({ name })),
      rows: [{ dimensionValues: ["20261001", "Organic Social", "instagram.com", "(not set)"].map((value) => ({ value })), metricValues: ["12", "11", "8", "1", "45.5"].map((value) => ({ value })) }],
    });
    expect(sources).toEqual([["2026-10-01", "Organic Social", "instagram.com", "(not set)", "12", "11", "8", "1.00", "45.50"]]);
    expect(gaRows(daily, { dimensionHeaders: [{ name: "date" }], metricHeaders: daily.columns.filter((c) => c.metric).map((c) => ({ name: c.metric })) })).toEqual([]);
  });

  it("GA4 refuses an answer it can't read rather than loading something wrong", () => {
    expect(() => gaRows(daily, { dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "activeUsers" }], rows: [] })).toThrow("didn't send newUsers");
    expect(() => gaDate("2026-10-01")).toThrow("date Tohyee can't read");
    expect(() => gaDate("20260231")).toThrow("date Tohyee can't read");
    expect(() => gaNumber("NaN")).toThrow("number Tohyee can't read");
    expect(gaNumber("1.2345E3")).toBe("1234.5");
    expect(gaNumber("-2.5e-3")).toBe("-0.0025");
    expect(gaNumber("120")).toBe("120");
    expect(gaNumber("3E2")).toBe("300");
  });

  it("GA5 loads 13 months by default: this month and the same month last year, whole", () => {
    expect(gaHistoryStart("2026-10-20", 13)).toBe("2025-10-01");
    expect(gaHistoryStart("2026-01-31", 1)).toBe("2026-01-01");
    expect(gaHistoryStart("2026-03-05", 25)).toBe("2024-03-01");
    expect(() => gaHistoryStart("2026-10-20", 0)).toThrow("between 1 and 60");
    expect(() => gaHistoryStart("2026-10-20", 61)).toThrow("between 1 and 60");
  });

  it("names the tables plainly and keeps their prefix for Google Analytics", () => {
    expect(tableLabel("google_analytics_daily")).toBe("Website by day");
    expect(tableLabel("google_analytics_traffic")).toBe("Website traffic sources");
    expect(tableNoun("google_analytics_daily")).toBe("days");
    expect(tableDescription("google_analytics_pages")).toContain("counts someone who came on two days twice");
    expect(isGaTable("google_analytics_daily")).toBe(true);
    expect(isGaTable("analytics_google")).toBe(false);
  });
});

describe("the Website template (decision 609)", () => {
  const columns = (report: (typeof GA_REPORTS)[number]) => report.columns.map((column) => ({ name: column.name, type: column.type }));
  const tables = GA_REPORTS.map((report) => ({ name: report.table, columns: columns(report) }));
  const invoices = { name: "tohyee_invoices", columns: [{ name: "invoice_date", type: "DATE" }, { name: "status", type: "VARCHAR" }, { name: "net", type: "DECIMAL(18,2)" }] };

  it("builds valid tiles over the Google Analytics tables, with sales beside them when the books are copied", () => {
    for (const set of [tables, [...tables, invoices]]) {
      const built = buildTemplate("website", set, "2026-10-20")!;
      const byName = new Map(set.map((table) => [table.name, table.columns]));
      for (const tile of built.tiles) {
        if (tile.query) expect(() => parseTileQuery(tile.query, byName), tile.title).not.toThrow();
        expect(() => parseChartFormat(tile.format), tile.title).not.toThrow();
      }
      expect(built.tiles.some((tile) => tile.title === "Sales by month")).toBe(set.length > tables.length);
    }
  });

  it("is offered only once Google Analytics is loaded", () => {
    expect(buildTemplate("website", [invoices], "2026-10-20")).toBeNull();
  });
});
