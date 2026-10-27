import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FarmSelector } from "@/components/farm-selector";
import type { Farm } from "@/lib/farming/paddocks";
const farms: Farm[] = Array.from({ length: 9 }, (_, i) => ({ id: `farm-${i + 1}`, name: `Property ${i + 1}`, notes: null, isActive: true, activePaddocks: 2, effectiveHa: "20.00", mappedHa: "20.00" }));
describe("compact multi-farm selection", () => {
  it("offers all nine farms in a labelled select and identifies the selected ninth farm", () => {
    const html = renderToStaticMarkup(createElement(FarmSelector, { farms, farm: farms[8], onChange: () => {} }));
    expect(html).toContain("Farm (9)");
    expect(html).toContain('<select');
    expect(html).toContain('value="farm-9" selected=""');
    for (const farm of farms) expect(html).toContain(farm.name);
    expect(html).not.toContain('role="tab"');
  });
  it("prompts for a farm without offering archived farms", () => {
    const html = renderToStaticMarkup(createElement(FarmSelector, { farms: [...farms, { ...farms[0], id: "archived", name: "Old property", isActive: false }], farm: null, onChange: () => {} }));
    // Not an empty page: each farm is a button to tap.
    expect(html).toContain("Which farm?");
    expect(html).toContain(">Property 9<");
    expect(html).not.toContain("in this tab");
    expect(html).not.toContain("Old property");
  });
  it("stays out of the way when there's one farm and it's showing", () => {
    expect(renderToStaticMarkup(createElement(FarmSelector, { farms: [farms[0]], farm: farms[0], onChange: () => {} }))).toBe("");
  });
  it("says why when a remembered or linked farm is archived or from elsewhere", () => {
    const html = renderToStaticMarkup(createElement(FarmSelector, { farms, farm: null, stale: true, onChange: () => {} }));
    expect(html).toContain("archived or isn&#x27;t in this organisation");
    expect(html).toContain('<option value="" disabled="" selected="">');
  });
});
describe("while the last farm is looked up", () => {
  it("doesn't ask for a farm before it knows", () => {
    const html = renderToStaticMarkup(createElement(FarmSelector, { farms, farm: null, deciding: true, onChange: () => {} }));
    expect(html).toContain("Opening your farm");
    expect(html).not.toContain("<select");
  });
});
