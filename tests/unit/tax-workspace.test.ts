import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncomeTaxView, taxViewOf } from "@/components/income-tax";
import { dependsOnForecast, forecastIncomplete, nextDue, taxTasks } from "@/lib/tax/income/workspace";

/** The income tax workspace (#375, decision 702), with made-up figures. */
const state = vi.hoisted(() => ({ path: "/operations/income-tax", report: {} as Record<string, unknown>, error: null as string | null }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path, useSearchParams: () => new URLSearchParams("incomeYear=2027"), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/hooks", () => ({ useApiData: () => ({ data: state.error ? null : { report: state.report }, error: state.error, reload: vi.fn() }) }));
vi.mock("@/components/modules", () => ({ useModules: () => ({ gst: true }) }));
const render = () => renderToStaticMarkup(createElement(IncomeTaxView, { organisationId: "demo" }));

const due = (key: string, dueDate: string, amount: string | null, estimate = true) => ({ key, label: key, dueDate, onTimeBy: { date: dueDate }, amount, estimate });

function emptyYear(): Record<string, unknown> {
  return {
    supported: true, incomeYear: 2027, years: [2026, 2027], endMonth: 3,
    accounts: [], adjustments: [], taxAssets: [], budgetName: null, payments: [],
    typed: { version: 0 }, settings: { version: 0, taxpayerType: "company" },
    lastYear: { incomeYear: 2026, rit: null, typed: false, filedOn: null },
    workpaper: { taxableIncome: "0.00", rit: "0.00" },
    endOfYear: { amount: "-1200.00" },
    interest: { soFar: { asAt: "2026-10-21" } },
    dueDates: [due("instalment-1", "2026-08-28", "1200.00", false), due("instalment-2", "2027-01-15", "1200.00", false), due("end-2027", "2028-02-07", "-1200.00")],
    notes: [], ir10: null, ir4: null, ir3: null, ica: null,
    actualsTo: "2026-09-30", budgetFrom: "2026-10-01",
  };
}

beforeEach(() => {
  state.path = "/operations/income-tax";
  state.error = null;
  state.report = emptyYear();
});

describe("which inputs are missing", () => {
  const base = { accounts: [], adjustments: [], taxAssets: [], typed: { version: 0 } } as unknown as Parameters<typeof forecastIncomplete>[0];
  it("is incomplete only with nothing to work from", () => {
    expect(forecastIncomplete(base)).toBe(true);
    expect(forecastIncomplete({ ...base, accounts: [{}] } as never)).toBe(false);
    expect(forecastIncomplete({ ...base, adjustments: [{}] } as never)).toBe(false);
    expect(forecastIncomplete({ ...base, taxAssets: [{}] } as never)).toBe(false);
    expect(forecastIncomplete({ ...base, typed: { version: 2 } } as never)).toBe(false);
  });
  it("leaves instalments from last year's tax alone: only this year's end-of-year tax comes from the forecast", () => {
    expect(dependsOnForecast({ key: "end-2027" }, 2027)).toBe(true);
    expect(dependsOnForecast({ key: "end-2026" }, 2027)).toBe(false);
    expect(dependsOnForecast({ key: "instalment-1" }, 2027)).toBe(false);
  });
  it("finds the next payment on or after today, by its on-time date", () => {
    const dates = [due("a", "2026-10-18", "1.00"), due("b", "2027-01-15", "2.00")];
    expect(nextDue(dates, "2026-10-21")?.key).toBe("b");
    // Due on a Sunday, on time the Monday: still next on the Monday.
    expect(nextDue([{ ...due("c", "2026-10-18", "1.00"), onTimeBy: { date: "2026-10-21" } } as never], "2026-10-21")?.key).toBe("c");
    expect(nextDue(dates, "2027-02-01")).toBeNull();
  });
  it("lists tasks from the report's own figures", () => {
    const report = { ...emptyYear(), payments: [{ reversed: false, awaiting: "500.00" }, { reversed: false, awaiting: "0.00" }, { reversed: true, awaiting: "90.00" }], lastYear: { rit: "3000.00", typed: false } } as never;
    expect(taxTasks(report).map((task) => [task.key, task.view])).toEqual([["forecast", "forecast"], ["allocate", "payments"], ["last-year", "payments"]]);
    expect(taxTasks({ ...emptyYear(), accounts: [{}] } as never)).toEqual([]);
  });
});

describe("income tax workspace (#375)", () => {
  it("says the forecast is incomplete instead of showing $0.00 tax or a refund", () => {
    const html = render();
    expect(html).toContain("Forecast incomplete");
    expect(html).not.toContain("Expected refund");
    expect(html).not.toContain('data-export-value="0.00"');
    expect(html).not.toContain('data-export-value="-1200.00"');
    // Instalments come from last year's tax, so they're still shown.
    expect(html).toContain('data-export-value="1200.00"');
    expect(html).not.toContain("Other adjustment");
    expect(html).toContain('href="/operations/income-tax/payments?incomeYear=2027"');
    expect(html).toMatch(/aria-current="page"[^>]*>Overview/);
  });
  it("shows a worked-out zero when there are inputs", () => {
    state.report = { ...emptyYear(), typed: { version: 1 }, endOfYear: { amount: "0.00" }, dueDates: [] };
    const html = render();
    expect(html).not.toContain("Forecast incomplete");
    expect(html).toContain('data-export-value="0.00"');
    expect(html).toContain("Nothing for this income year.");
  });
  it("shows a refund as a refund once there are inputs", () => {
    state.report = { ...emptyYear(), accounts: [{}] };
    expect(render()).toContain("Expected refund");
  });
  it("names the next payment due", () => {
    const html = render();
    expect(html).toContain("Next payment to IRD");
    expect(html).toContain("instalment-2");
  });
  it("puts forecast basis and notes on the Forecast page only", () => {
    state.path = "/operations/income-tax/forecast";
    state.report.notes = ["Actuals only until a budget is entered."];
    const html = render();
    expect(html).toContain("What the forecast is based on");
    expect(html).toContain("Actuals only until a budget is entered.");
    expect(html).not.toContain("Due dates");
    expect(html).toMatch(/aria-current="page"[^>]*>Forecast/);
  });
  it("keeps the year in every workspace link", () => {
    const html = render();
    for (const view of ["forecast", "calculation", "payments", "returns", "settings"]) expect(html).toContain(`href="/operations/income-tax/${view}?incomeYear=2027"`);
    expect(html).toContain('href="/operations/income-tax?incomeYear=2027"');
  });
  it("links GST returns from Returns", () => {
    state.path = "/operations/income-tax/returns";
    const html = render();
    expect(html).toContain('href="/operations/gst-return"');
    expect(html).not.toContain("Forecast incomplete");
  });
  it("offers tax settings when the taxpayer isn't set up", () => {
    state.report = { supported: false, reason: "Choose a taxpayer type.", settings: { version: 0 }, incomeYear: 2027, years: [2027], endMonth: 3 };
    const html = render();
    expect(html).toContain("Choose a taxpayer type.");
    expect(html).toContain('href="/operations/income-tax/settings?incomeYear=2027"');
  });
  it("shows an error from the server, keeping the workspace's navigation", () => {
    state.error = "Something went wrong.";
    const html = render();
    expect(html).toContain("Something went wrong.");
    expect(html).toContain('aria-label="Income tax"');
  });
  it("reads the page from the address", () => {
    expect(taxViewOf("/operations/income-tax")).toBe("overview");
    expect(taxViewOf("/operations/income-tax/payments")).toBe("payments");
    expect(taxViewOf("/operations/income-tax/unknown")).toBe("overview");
  });
});
