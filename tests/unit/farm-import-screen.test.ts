import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ImportPaddocks } from "@/components/farming";
vi.mock("@/components/workspace", () => ({ useWorkspace: () => ({ user: { id: "owner" }, can: () => true }) }));
vi.mock("@/components/hooks", () => ({ useApiData: () => ({ data: { farms: Array.from({ length: 9 }, (_, i) => ({ id: `farm-${i + 1}`, name: `Property ${i + 1}`, isActive: true })) }, error: null, reload: () => {} }) }));
describe("import destination for nine farms", () => {
  const render = (farmId: string | null) => renderToStaticMarkup(createElement(ImportPaddocks, { organisationId: "org-a", farmId }));
  it("requires a choice when opened without a destination", () => {
    const html = render(null);
    expect(html).toContain('<option value="" disabled="" selected="">');
    expect(html).not.toMatch(/value="farm-\d" selected/);
  });
  it("does not substitute the first farm for an invalid deep link", () => {
    const html = render("other-organisation-farm");
    expect(html).toContain('<option value="" disabled="" selected="">');
    expect(html).not.toMatch(/value="farm-\d" selected/);
  });
  it("honours a valid deep link to the ninth farm", () => {
    expect(render("farm-9")).toContain('value="farm-9" selected=""');
  });
});
