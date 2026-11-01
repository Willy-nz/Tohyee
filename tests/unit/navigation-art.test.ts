import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { iconForDestination } from "@/components/navigation-art";
import { MENUS, CRM_MENUS, ANALYTICS_MENUS, FARM_MENUS } from "@/components/navigation";
import { PageHeader } from "@/components/ui";

const state = vi.hoisted(() => ({ path: "/crm" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));

describe("illustrated module navigation", () => {
  it("covers the four apps and accounting work areas", () => {
    for (const [path, icon] of Object.entries({
      "/operations": "accounting", "/crm": "crm", "/analytics": "analytics", "/operations/farm": "farm",
      "/operations/payroll/employees": "payroll", "/operations/tax": "tax", "/operations/jobs": "jobs",
      "/operations/bank-accounts": "banking", "/operations/reports": "reports", "/operations/settings": "settings",
      "/operations/items": "inventory", "/operations/sales": "sales", "/operations/purchases": "purchases",
      "/server/users": "crm",
    })) expect(iconForDestination(path)).toBe(icon);
  });
  it("keeps child artwork specific and ignores query strings, fragments and trailing slashes", () => {
    expect(iconForDestination("/operations/farm/effluent/ponds?farm=demo#reading")).toBe("effluent");
    expect(iconForDestination("/operations/farming/safety/")).toBe("safety");
    expect(iconForDestination("/operations/farmish")).toBe("accounting");
    expect(iconForDestination("/crm-other")).toBeUndefined();
    expect(iconForDestination("https://example.com/crm")).toBeUndefined();
    expect(iconForDestination("//example.com/crm")).toBeUndefined();
    expect(iconForDestination(null)).toBeUndefined();
  });
  it("provides artwork for every existing in-app menu destination", () => {
    const links = [...MENUS, ...CRM_MENUS, ...ANALYTICS_MENUS, ...FARM_MENUS].flatMap(menu => [
      ...(menu.href ? [menu.href] : []), ...menu.groups.flatMap(group => group.links.map(link => link.href)),
    ]).filter(path => /^(\/operations|\/crm|\/analytics)(\/|$|\?)/.test(path));
    for (const href of links) expect(iconForDestination(href), href).toBeDefined();
  });
  it("keeps page titles, descriptions and actions readable with decorative art", () => {
    state.path = "/crm";
    const html = renderToStaticMarkup(createElement(PageHeader, { title: "Companies", description: "Your contacts", actions: createElement("button", null, "Add company") }));
    expect(html).toContain("Companies</h1>");
    expect(html).toContain("Your contacts");
    expect(html).toContain("Add company</button>");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    state.path = null;
    expect(renderToStaticMarkup(createElement(PageHeader, { title: "Sign in" }))).not.toContain("<svg");
  });
});
