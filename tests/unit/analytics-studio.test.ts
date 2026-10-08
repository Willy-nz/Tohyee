import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsNavigation, ConnectorPicker } from "@/components/analytics/studio";

const access = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@/components/workspace", () => ({ useWorkspace: () => ({ can: (role: string) => access.role === "admin" || (access.role === "viewer" && role === "viewer") }) }));

describe("Analytics workspace access and connectors", () => {
  it("keeps source and shaping navigation away from report viewers", () => {
    access.role = "report_viewer";
    const html = renderToStaticMarkup(createElement(AnalyticsNavigation, { active: "reports" }));
    expect(html).toContain("Reports");
    expect(html).not.toContain("Data sources");
    expect(html).not.toContain("Prepare data");
  });
  it("gives members a source library and admins data preparation", () => {
    access.role = "admin";
    const html = renderToStaticMarkup(createElement(AnalyticsNavigation, { active: "sources" }));
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Data sources");
    expect(html).toContain("Prepare data");
  });
  it("offers implemented connectors and explains external service limitations", () => {
    const html = renderToStaticMarkup(createElement(ConnectorPicker, { selected: null, onSelect: () => undefined }));
    expect(html).toContain("CSV file");
    expect(html).toContain("Excel workbook");
    expect(html).toContain("Books and CRM");
    expect(html).toContain("Report emails");
    expect(html).toContain("Direct connections to Google Sheets, BigQuery and external SQL databases are not available yet");
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/modules", () => ({ useModules: () => ({ analytics: true }) }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/hooks", () => ({ useApiData: () => ({ data: { dashboard: { id: "report", name: "Client report", description: null, settings: { from: null, to: null, slicers: [] }, tiles: [] } }, reload: vi.fn() }) }));

import { DashboardView } from "@/components/analytics-dashboards";

it("ignores an edit URL for report viewers", () => {
  access.role = "report_viewer";
  const html = renderToStaticMarkup(createElement(DashboardView, { organisationId: "org", dashboardId: "report", startEditing: true }));
  expect(html).toContain("Client report");
  expect(html).not.toContain("Save and view");
  expect(html).not.toContain("Add chart");
  expect(html).not.toContain("Share</button>");
});
