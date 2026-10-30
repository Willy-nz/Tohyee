import { describe, expect, it } from "vitest";
import {
  GSC_ROW_LIMIT,
  GSC_TABLE_PREFIX,
  GSC_TABLES,
  gscAddDays,
  gscChangingFrom,
  gscCountryName,
  gscDays,
  gscDeviceName,
  gscHistoryStart,
  gscLoadWindow,
  gscNumber,
  gscReadAllPages,
  gscRequestBody,
  gscRows,
  gscSiteLabel,
  gscTableColumns,
  gscToday,
  isGscTable,
  type GscResponse,
} from "@/lib/analytics/search-console-reports";
import { combineFreshness, loadKeyOf, mayChangeSql } from "@/lib/analytics/freshness";
import { freshnessText } from "@/components/analytics/report-freshness";
import { buildTemplate } from "@/lib/analytics/templates";
import { tableDescription, tableLabel } from "@/lib/analytics/labels";
import { parseTileQuery } from "@/lib/analytics/query";
import { parseChartFormat } from "@/lib/analytics/chart-format";

const table = (name: string) => GSC_TABLES.find((entry) => entry.table === name)!;
const daily = table("google_search_console_daily");
const queries = table("google_search_console_queries");

/** Examples GSC3-GSC5 in docs/ACCOUNTING-EXAMPLES.md (Google Search Console, as Looker Studio's connector does, not yet reviewed). Made-up figures. */
describe("Search Console days (decisions 1182-1183)", () => {
  it("GSC3 uses Google's Pacific-time days", () => {
    // 9am 1 Nov in New Zealand is still 31 Oct in California.
    expect(gscToday(new Date("2026-10-31T20:00:00Z"))).toBe("2026-10-31");
    expect(gscToday(new Date("2026-11-01T06:59:00Z"))).toBe("2026-10-31");
    expect(gscToday(new Date("2026-11-01T08:00:00Z"))).toBe("2026-11-01");
    expect(gscAddDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(gscDays("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(gscDays("2026-10-30", "2026-10-29")).toEqual([]);
  });

  it("GSC3 the first load goes back 16 months, as far as Google keeps", () => {
    expect(gscHistoryStart("2026-10-31")).toBe("2025-06-30");
    expect(gscHistoryStart("2026-10-15")).toBe("2025-06-15");
    expect(gscHistoryStart("2026-04-30")).toBe("2024-12-30");
    expect(gscLoadWindow("2026-10-31", { loadedThrough: null, changingFrom: null, tablesPresent: false })).toEqual({ from: "2025-06-30", to: "2026-10-31", first: true });
    // Loaded before but the tables are gone: start again.
    expect(gscLoadWindow("2026-10-31", { loadedThrough: "2026-10-30", changingFrom: "2026-10-27", tablesPresent: false }).first).toBe(true);
  });

  it("GSC4 later loads fetch only the new days and the days that may still change", () => {
    expect(gscLoadWindow("2026-10-31", { loadedThrough: "2026-10-30", changingFrom: "2026-10-27", tablesPresent: true })).toEqual({ from: "2026-10-27", to: "2026-10-31", first: false });
    // Nothing changing: from the day after the last loaded.
    expect(gscLoadWindow("2026-10-31", { loadedThrough: "2026-10-20", changingFrom: null, tablesPresent: true })).toEqual({ from: "2026-10-21", to: "2026-10-31", first: false });
    // A load stopped part-way carries on from where it stopped.
    expect(gscLoadWindow("2026-10-31", { loadedThrough: "2025-12-31", changingFrom: null, tablesPresent: true }).from).toBe("2026-01-01");
    // Not loaded for two years: no earlier than Google keeps.
    expect(gscLoadWindow("2026-10-31", { loadedThrough: "2024-01-01", changingFrom: null, tablesPresent: true }).from).toBe("2025-06-30");
    // Loaded today already: today again.
    expect(gscLoadWindow("2026-10-31", { loadedThrough: "2026-10-31", changingFrom: null, tablesPresent: true }).from).toBe("2026-10-31");
  });

  it("GSC4 today and the three days before it may still change, or from Google's first incomplete day if earlier", () => {
    expect(gscChangingFrom("2026-10-31", null)).toBe("2026-10-28");
    expect(gscChangingFrom("2026-10-31", "2026-10-30")).toBe("2026-10-28");
    expect(gscChangingFrom("2026-10-31", "2026-10-25")).toBe("2026-10-25");
    expect(gscChangingFrom("2026-10-31", "not a date")).toBe("2026-10-28");
  });
});

describe("asking Google and reading its answers (decision 1181)", () => {
  it("GSC3 asks searchanalytics.query for every row, web search by default, partial days included", () => {
    expect(gscRequestBody(queries, "2026-10-01", "2026-10-01", 0)).toEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      dimensions: ["date", "query"],
      type: "web",
      dataState: "all",
      aggregationType: "auto",
      rowLimit: 25_000,
      startRow: 0,
    });
    expect(gscRequestBody(daily, "2025-06-30", "2026-10-31", 25_000, "image")).toMatchObject({ dimensions: ["date"], type: "image", startRow: 25_000 });
    expect(GSC_TABLES.map((entry) => [entry.table, entry.perDay])).toEqual([
      ["google_search_console_daily", false],
      ["google_search_console_queries", true],
      ["google_search_console_pages", true],
      ["google_search_console_countries", true],
      ["google_search_console_devices", true],
    ]);
    for (const entry of GSC_TABLES) {
      expect(entry.table.startsWith(GSC_TABLE_PREFIX)).toBe(true);
      expect(entry.dimensions[0]).toBe("date");
    }
  });

  it("GSC3 pages through with startRow until a page comes back short", async () => {
    const row = (n: number) => ({ keys: ["2026-10-01", `q${n}`], clicks: 1, impressions: 2, ctr: 0.5, position: 3 });
    const asked: number[] = [];
    const full = Array.from({ length: GSC_ROW_LIMIT }, (_, n) => row(n));
    const read = await gscReadAllPages(async (startRow) => {
      asked.push(startRow);
      if (startRow === 0) return { rows: full, metadata: { firstIncompleteDate: "2026-10-03" } };
      if (startRow === GSC_ROW_LIMIT) return { rows: full.slice(0, 3), metadata: { firstIncompleteDate: "2026-10-02" } };
      throw new Error("asked too far");
    });
    expect(asked).toEqual([0, 25_000]);
    expect(read.rows).toHaveLength(25_003);
    expect(read.firstIncompleteDate).toBe("2026-10-02");
    // An empty answer (no rows key at all) is one page and no rows.
    const empty = await gscReadAllPages(async () => ({}) as GscResponse);
    expect(empty).toEqual({ rows: [], firstIncompleteDate: null });
    // A full page every time stops at the limit rather than running on.
    await expect(gscReadAllPages(async () => ({ rows: full }))).rejects.toThrow("more pages than it should");
  });

  it("GSC5 turns rows into plain columns with exact decimals, names and the may-still-change mark", () => {
    const rows = [
      { keys: ["2026-10-27", "paw print necklace"], clicks: 12, impressions: 340, ctr: 0.03529411764705882, position: 4.538235294117647 },
      { keys: ["2026-10-28", "nose print ring"], clicks: 0, impressions: 1500, ctr: 0, position: 8.2 },
      { keys: ["2026-10-29", "pet keepsake"], clicks: 3, impressions: 3, ctr: 1, position: 1 },
    ];
    expect(gscRows(queries, rows, "2026-10-28")).toEqual([
      ["2026-10-27", "paw print necklace", "12", "340", "0.035294", "4.54", "false"],
      ["2026-10-28", "nose print ring", "0", "1500", "0.000000", "8.20", "true"],
      ["2026-10-29", "pet keepsake", "3", "3", "1.000000", "1.00", "true"],
    ]);
    expect(gscTableColumns(queries)).toEqual([
      { name: "date", type: "DATE" },
      { name: "query", type: "VARCHAR" },
      { name: "clicks", type: "BIGINT" },
      { name: "impressions", type: "BIGINT" },
      { name: "click_rate", type: "DECIMAL(18,6)" },
      { name: "average_position", type: "DECIMAL(18,2)" },
      { name: "may_still_change", type: "BOOLEAN" },
    ]);
    const countries = table("google_search_console_countries");
    expect(gscRows(countries, [{ keys: ["2026-10-27", "nzl"], clicks: 5, impressions: 50, ctr: 0.1, position: 2.5 }], "2026-10-28")[0].slice(0, 3)).toEqual(["2026-10-27", "New Zealand", "nzl"]);
    expect(gscCountryName("aus")).toBe("Australia");
    expect(gscCountryName("USA")).toBe("United States");
    expect(gscCountryName("zzz")).toBe("Unknown region");
    expect(gscDeviceName("MOBILE")).toBe("Mobile");
    expect(gscDeviceName("DESKTOP")).toBe("Computer");
    expect(gscDeviceName("TABLET")).toBe("Tablet");
    expect(gscNumber(1.5e-7)).toBe("0.00000015");
    expect(() => gscNumber("12")).toThrow("number Tohyee can't read");
    expect(() => gscNumber(Number.NaN)).toThrow("number Tohyee can't read");
    expect(() => gscRows(queries, [{ keys: ["2026-10-27"], clicks: 1, impressions: 1, ctr: 1, position: 1 }], "2026-10-28")).toThrow("row Tohyee can't read");
    expect(() => gscRows(daily, [{ keys: ["2026-02-30"], clicks: 1, impressions: 1, ctr: 1, position: 1 }], "2026-10-28")).toThrow("date Tohyee can't read");
  });

  it("names the tables plainly, explains average position, and keeps the prefix", () => {
    expect(tableLabel("google_search_console_queries")).toBe("Website search queries");
    expect(tableDescription("google_search_console_daily")).toContain("1 is the top result");
    expect(tableDescription("google_search_console_queries")).toContain("protect their privacy");
    expect(isGscTable("google_search_console_daily")).toBe(true);
    expect(isGscTable("google_analytics_daily")).toBe(false);
    expect(gscSiteLabel("sc-domain:example.co.nz")).toBe("example.co.nz (whole domain)");
    expect(gscSiteLabel("https://www.example.co.nz/")).toBe("https://www.example.co.nz/");
  });
});

describe("Search Console in report freshness (decision 1183)", () => {
  it("GSC4 records loads under one name and says from which day Google may still change the figures", () => {
    expect(loadKeyOf("google_search_console_pages")).toEqual({ tableName: "google_search_console_*", sourceless: true });
    expect(mayChangeSql("google_search_console_daily")).toBe('select cast(min("date") as VARCHAR) as changing from "google_search_console_daily" where "may_still_change"');
    expect(mayChangeSql("tohyee_invoices")).toBeNull();
    const facts = [{ name: "Google Search Console", tables: ["google_search_console_daily", "google_search_console_queries"], refreshedAt: "2026-10-31T16:00:00.000Z", failedAt: null, running: false }];
    const report = combineFreshness(facts, new Map([["google_search_console_daily", "2026-10-31"]]), new Map([["google_search_console_daily", "2026-10-28"], ["google_search_console_queries", "2026-10-29"]]));
    expect(report.sources[0]).toMatchObject({ dataThrough: "2026-10-31", mayChangeFrom: "2026-10-28" });
    expect(freshnessText(report.sources[0])).toMatch(/data up to 31 Oct 2026\. Google may still change the days from 28 Oct 2026\.$/);
    // Other sources are as they were.
    expect(combineFreshness([{ ...facts[0], name: "Sales", tables: ["sales"] }], new Map()).sources[0]).not.toHaveProperty("mayChangeFrom");
  });
});

describe("the Website search template (decision 1186)", () => {
  const tables = GSC_TABLES.map((entry) => ({ name: entry.table, columns: gscTableColumns(entry) }));

  it("GSC9 builds valid tiles: totals, clicks and impressions over time, top searches and pages, low click rates, countries and devices", () => {
    const built = buildTemplate("search", tables, "2026-10-31")!;
    expect(built.name).toBe("Website search");
    const byName = new Map(tables.map((entry) => [entry.name, entry.columns]));
    for (const tile of built.tiles) {
      if (tile.query) expect(() => parseTileQuery(tile.query, byName), tile.title).not.toThrow();
      expect(() => parseChartFormat(tile.format), tile.title).not.toThrow();
    }
    expect(built.tiles.map((tile) => tile.title)).toEqual([
      "Website search",
      "Clicks",
      "Impressions",
      "Click rate",
      "Average position",
      "Clicks and impressions by week",
      "Top searches",
      "Top pages",
      "Shown a lot, rarely clicked",
      "Clicks by country",
      "Clicks by device",
    ]);
    // Average position is weighted by impressions, as Google works it out, and lower is better.
    const position = built.tiles.find((tile) => tile.title === "Average position")!;
    expect(position.query!.measures[0]).toMatchObject({ formula: "[Position x impressions] / [Impressions]" });
    expect(position.format?.kpi?.downIsGood).toBe(true);
    const low = built.tiles.find((tile) => tile.title === "Shown a lot, rarely clicked")!;
    expect(low.query).toMatchObject({ groupBy: { field: "query" }, sort: { by: "value", direction: "desc" }, limit: 20 });
    expect(low.query!.measures.map((measure) => measure.label)).toEqual(["Impressions", "Clicks", "Click rate", "Average position"]);
    expect(built.tiles[0].text).toContain("may still change");
  });

  it("is offered only once Search Console is loaded", () => {
    expect(buildTemplate("search", tables.slice(0, 4), "2026-10-31")).toBeNull();
  });
});
