import { describe, expect, it } from "vitest";
import { combineFreshness, dataThroughSql, failedReasonText, loadKeyOf, MAX_FAILED_REASON } from "@/lib/analytics/freshness";
import { freshnessText } from "@/components/analytics/report-freshness";

/** Report freshness (#387, decision 698). */

const at = (iso: string) => new Date(iso).toISOString();

describe("report freshness", () => {
  it("finds where each table's loads are recorded", () => {
    expect(loadKeyOf("tohyee_invoices")).toEqual({ tableName: "tohyee_*", sourceless: true });
    expect(loadKeyOf("google_analytics_daily")).toEqual({ tableName: "google_analytics_*", sourceless: true });
    expect(loadKeyOf("sales")).toEqual({ tableName: "sales", sourceless: false });
  });

  it("says why a refresh failed, in a line, when the reader may be told (#694)", () => {
    expect(failedReasonText(null)).toBeNull();
    expect(failedReasonText("  \n ")).toBeNull();
    expect(failedReasonText("The file\n  sales.csv   has no rows")).toBe("The file sales.csv has no rows");
    const long = failedReasonText("x".repeat(500))!;
    expect(long.length).toBe(MAX_FAILED_REASON);
    expect(long.endsWith("…")).toBe(true);
    const failed = { name: "Books and CRM", tables: ["tohyee_invoices"], refreshedAt: at("2026-11-12T15:02:00Z"), failedAt: at("2026-11-13T22:15:00Z"), running: false };
    const withReason = combineFreshness([{ ...failed, failedReason: "The books' database didn't answer in time" }], new Map()).sources[0];
    expect(withReason.failedReason).toBe("The books' database didn't answer in time");
    expect(freshnessText(withReason)).toMatch(/the last refresh failed .* It may be out of date\. Why: The books' database didn't answer in time\.$/);
    // Not told why (a report viewer, or no reason recorded): the line is as it was.
    const without = combineFreshness([failed], new Map()).sources[0];
    expect(without).not.toHaveProperty("failedReason");
    expect(freshnessText(without)).toMatch(/It may be out of date\.$/);
  });

  it("gives each source its latest date and says when sources are from different times", () => {
    const facts = [
      { name: "Books and CRM", tables: ["tohyee_invoices", "tohyee_ledger_lines"], refreshedAt: at("2026-10-20T15:05:00Z"), failedAt: null, running: false },
      { name: "Sales", tables: ["sales"], refreshedAt: at("2026-10-18T09:00:00Z"), failedAt: null, running: false },
    ];
    const through = new Map([
      ["tohyee_invoices", "2026-10-19"],
      ["tohyee_ledger_lines", "2026-10-20"],
      ["sales", null],
    ]);
    const report = combineFreshness(facts, through);
    expect(report.sources.map((source) => source.dataThrough)).toEqual(["2026-10-20", null]);
    expect(report.mixed).toBe(true);
    expect(combineFreshness([facts[0], { ...facts[1], refreshedAt: at("2026-10-20T15:30:00Z") }], through).mixed).toBe(false);
    expect(dataThroughSql("sales", [])).toBeNull();
    expect(dataThroughSql("sales", ["order_date", "ship_date"])).toBe('select cast(greatest(max(cast("order_date" as DATE)), max(cast("ship_date" as DATE))) as VARCHAR) as through from "sales"');
  });

  it("never calls a failed or running refresh refreshed", () => {
    const base = { name: "Sales", tables: ["sales"], refreshedAt: at("2026-10-18T09:00:00Z"), failedAt: null, running: false, dataThrough: "2026-10-17" };
    expect(freshnessText(base)).toMatch(/^Sales refreshed .*, data up to 17 Oct 2026\.$/);
    const failed = freshnessText({ ...base, failedAt: at("2026-10-19T09:00:00Z") });
    expect(failed).toMatch(/^Sales: the last refresh failed \(.*\), so this is still the data loaded .*\. It may be out of date\.$/);
    expect(failed).not.toMatch(/ refreshed /);
    expect(freshnessText({ ...base, running: true })).toMatch(/^Sales is refreshing now; showing the data loaded /);
    expect(freshnessText({ ...base, refreshedAt: null, failedAt: at("2026-10-19T09:00:00Z"), dataThrough: null })).toMatch(/no data has loaded yet/);
  });
});
