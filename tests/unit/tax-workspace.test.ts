import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncomeTaxView } from "@/components/income-tax";

const state = vi.hoisted(() => ({ path: "/operations/income-tax", report: {} as Record<string, unknown> }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path, useSearchParams: () => new URLSearchParams("incomeYear=2027"), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/hooks", () => ({ useApiData: () => ({ data: { report: state.report }, error: null, reload: vi.fn() }) }));
const render = () => renderToStaticMarkup(createElement(IncomeTaxView, { organisationId: "demo" }));

beforeEach(() => {
  state.path = "/operations/income-tax";
  state.report = {
    supported: true, incomeYear: 2027, years: [2026, 2027], endMonth: 3,
    accounts: [], adjustments: [], taxAssets: [], budgetName: null,
    typed: { version: 0 }, settings: { version: 0, taxpayerType: "company" },
    workpaper: { taxableIncome: "0.00", rit: "0.00" },
    endOfYear: { amount: "0.00" }, dueDates: [], notes: [],
    actualsTo: "2026-09-30", budgetFrom: "2026-10-01",
  };
});

describe("income tax workspace (#375)", () => {
  it("keeps an empty forecast visibly incomplete without rendering adjustment and payment forms", () => {
    const html = render();
    expect(html).toContain("Forecast needs review");
    expect(html).toContain("Not ready");
    expect(html).not.toContain('data-export-value="0.00"');
    expect(html).not.toContain("Other adjustment");
    expect(html).not.toContain("Allocate this payment");
    expect(html).toContain('href="/operations/income-tax/payments?incomeYear=2027"');
    expect(html).toContain('aria-current="page"');
  });
  it("preserves a real zero when tax figures have been entered", () => {
    state.report.typed = { version: 1 };
    const html = render();
    expect(html).not.toContain("Not ready");
    expect(html).toContain('data-export-value="0.00"');
  });
  it("shows forecast basis and notes separately from the overview and calculations", () => {
    state.path = "/operations/income-tax/forecast";
    state.report.notes = ["Actuals only until a budget is entered."];
    const html = render();
    expect(html).toContain("Forecast basis");
    expect(html).toContain("Actuals only until a budget is entered.");
    expect(html).not.toContain("Due dates");
    expect(html).not.toContain("Other adjustment");
  });
  it("provides a settings route when the taxpayer is not supported", () => {
    state.report = { ...state.report, supported: false, reason: "Choose a taxpayer type." };
    const html = render();
    expect(html).toContain("Choose a taxpayer type.");
    expect(html).toContain('href="/operations/income-tax/settings?incomeYear=2027"');
  });
});
