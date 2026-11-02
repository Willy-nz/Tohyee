import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { iconForDestination, iconForMenu } from "@/components/navigation-art";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MENUS, CRM_MENUS, ANALYTICS_MENUS, FARM_MENUS, type Menu } from "@/components/navigation";
import { IllustratedIcon, type IllustratedIconName } from "@/components/illustrated-icon";
import { SERVER_LINKS } from "@/components/server-shell";
import { PageHeader } from "@/components/ui";

const state = vi.hoisted(() => ({ path: "/crm" as string | null }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));

describe("illustrated module navigation", () => {
  it("covers the four apps and accounting work areas", () => {
    for (const [path, icon] of Object.entries({
      "/operations": "accounting", "/crm": "crm", "/analytics": "analytics", "/operations/farm": "farm",
      "/operations/payroll/pay-runs": "payroll", "/operations/gst-return": "tax-return", "/operations/jobs": "jobs",
      "/operations/bank-accounts": "banking", "/operations/reports": "reports", "/operations/settings": "settings",
      "/operations/items": "inventory", "/operations/sales": "sales", "/operations/purchases": "purchases",
      "/server/users": "team",
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
  it("gives settings pages a picture of what they're about, keeping the cog for general settings", () => {
    for (const [path, icon] of Object.entries({
      "/operations/settings": "settings", "/operations/settings/all": "settings", "/operations/modules": "settings",
      "/operations/settings/custom-fields": "settings", "/operations/settings/tracking": "settings", "/server": "settings",
      "/server/updates": "settings",
      "/operations/settings/sales-platforms": "shop", "/operations/settings/sales-platforms?platform=woocommerce": "shop",
      "/operations/settings/online-payments": "card", "/operations/settings/email": "mail",
      "/operations/settings/bank-files": "banking", "/operations/settings/import": "documents",
      "/operations/settings/powerpoint": "reports", "/operations/settings/payroll-access": "payroll",
      "/operations/settings/customers": "crm", "/operations/settings/salespeople": "team",
      "/operations/settings/approval-rules": "approval", "/operations/settings/kilometre-rates": "vehicle",
      "/operations/members": "team",
      "/crm/teams": "team", "/crm/reassign": "reassign", "/crm/duplicates": "duplicates",
      "/crm/record-types": "form", "/crm/stages": "pipeline", "/analytics/shaping": "funnel",
      "/server/sign-ins": "key", "/server/google-sign-in": "key", "/server/remote-access": "key",
    })) expect(iconForDestination(path), path).toBe(icon);
    expect(iconForMenu(MENUS.find((menu) => menu.label === "Settings")!)).toBe("settings");
  });
  it("shows the cog only on the Settings hubs and general settings in every app's menus", () => {
    const allowed = new Set(["/operations/settings", "/operations/settings/all", "/operations/modules", "/operations/settings/tracking", "/operations/settings/custom-fields"]);
    const cogs = [...MENUS, ...CRM_MENUS, ...ANALYTICS_MENUS, ...FARM_MENUS]
      .flatMap((menu) => [...(menu.href ? [menu.href] : []), ...menu.groups.flatMap((group) => group.links.map((link) => link.href))])
      .filter((href) => iconForDestination(href) === "settings" && !allowed.has(href.split(/[?#]/)[0]));
    expect(cogs).toEqual([]);
    // CRM Settings opens on Teams, but the menu itself still shows the cog.
    expect(iconForMenu(CRM_MENUS.find((menu) => menu.label === "Settings")!)).toBe("settings");
    expect(iconForMenu({ art: "shop", href: "/crm" })).toBe("shop");
  });
  it("chooses a menu's artwork from where it leads, not its label", () => {
    const art = (menus: typeof MENUS, label: string) => iconForMenu(menus.find((menu) => menu.label === label)!);
    expect(art(MENUS, "Sales")).toBe("sales");
    expect(art(CRM_MENUS, "Sales")).toBe("pipeline");
    expect(art(CRM_MENUS, "More")).toBe("mail");
    expect(art(CRM_MENUS, "Contacts")).toBe("crm");
    expect(art(FARM_MENUS, "More")).toBe("farm");
    expect(art(CRM_MENUS, "Settings")).toBe("settings");
    expect(art(MENUS, "Tax")).toBe("tax");
    expect(art(ANALYTICS_MENUS, "Data sources")).toBe("documents");
    expect(iconForDestination("/operations/income-tax")).toBe("coins");
    expect(iconForDestination("/operations/project-reports/time")).toBe("clock");
    expect(iconForDestination("/operations/project-reports/other")).toBe("reports");
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

  it("gives every Tax page its own picture and keeps the calculator for the Tax menu", () => {
    const tax = MENUS.find((menu) => menu.label === "Tax")!;
    expect(iconForMenu(tax)).toBe("tax");
    expect(Object.fromEntries(tax.groups.flatMap((group) => group.links).map((link) => [link.label, iconForDestination(link.href)]))).toEqual({
      "GST return": "tax-return", "GST audit report": "inspect", "Tax codes": "tax-code", "Income tax": "coins",
      "R&D activities": "flask", "Tagged R&D costs": "tagged-receipt", "R&D claim report": "rd-claim",
    });
  });
  it("matches a route that names a query on that page and query only", () => {
    expect(iconForDestination("/operations/reports?report=bs")).toBe("scales");
    expect(iconForDestination("/operations/reports/?report=bs#notes")).toBe("scales");
    expect(iconForDestination("/operations/reports?from=2026-04-01&report=aged")).toBe("awaiting");
    expect(iconForDestination("/operations/reports?report=pnl")).toBe("reports");
    expect(iconForDestination("/operations/reports?report=unknown")).toBe("reports");
    expect(iconForDestination("/operations/reports")).toBe("reports");
    expect(iconForDestination("/operations/invoices?show=awaiting")).toBe("awaiting");
    expect(iconForDestination("/operations/invoices?show=drafts")).toBe("sales");
    expect(iconForDestination("/operations/invoices/123?show=awaiting")).toBe("sales");
  });

  /**
   * Three or more different pages in one menu with the same picture looks
   * like a placeholder (Jess, 2 November 2026: the Tax menu). Two may share
   * when they're the same kind of thing. Links to the same page count once
   * (Not-for-profit's Fund activity is the Profit and loss page).
   */
  const SHARED_ALLOWED: Record<string, { icon: IllustratedIconName; why: string }[]> = {
    // Sign-ins, Sign in with Google and Remote access are all about getting in (decision 1234).
    // The server bar shows no pictures; this is their page headings only.
    "Server": [{ icon: "key", why: "ways in to the server" }],
  };
  function crowded(name: string, hrefs: string[]): string[] {
    const by = new Map<string, Set<string>>();
    for (const href of hrefs) {
      const icon = iconForDestination(href) ?? "(none)";
      by.set(icon, (by.get(icon) ?? new Set()).add(href.split("#")[0]));
    }
    const allowed = new Set((SHARED_ALLOWED[name] ?? []).map((entry) => entry.icon));
    return [...by].filter(([icon, pages]) => pages.size >= 3 && !allowed.has(icon as IllustratedIconName)).map(([icon, pages]) => `${name}: ${icon} × ${pages.size} (${[...pages].join(", ")})`);
  }
  it("never shows one picture on three or more pages of the same menu", () => {
    const apps: Array<[string, Menu[]]> = [["Accounting", MENUS], ["CRM", CRM_MENUS], ["Analytics", ANALYTICS_MENUS], ["Farm", FARM_MENUS]];
    const problems: string[] = [];
    for (const [app, menus] of apps) {
      for (const menu of menus) problems.push(...crowded(`${app} › ${menu.label}`, menu.groups.flatMap((group) => group.links.map((link) => link.href))));
      // The phone menu lists each app's menus with their pictures too.
      const art = new Map<string, string[]>();
      for (const menu of menus) art.set(iconForMenu(menu) ?? "(none)", [...(art.get(iconForMenu(menu) ?? "(none)") ?? []), menu.label]);
      for (const [icon, labels] of art) if (labels.length >= 3) problems.push(`${app} top bar: ${icon} × ${labels.length} (${labels.join(", ")})`);
    }
    problems.push(...crowded("Server", SERVER_LINKS.map((link) => link.href)));
    expect(problems).toEqual([]);
    // The check itself catches a crowded menu, and the allowlist stays small.
    expect(crowded("Example", ["/operations/invoices", "/operations/sales", "/operations/sales/x"])).toHaveLength(1);
    expect(Object.values(SHARED_ALLOWED).flat().length).toBeLessThanOrEqual(3);
  });
  it("keeps the inline artwork and the SVG files in step", () => {
    const folder = join(process.cwd(), "public/illustrations/icons");
    const files = readdirSync(folder).filter((file) => file.endsWith(".svg")).map((file) => file.replace(/\.svg$/, "")).sort();
    const routeIcons = new Set([...MENUS, ...CRM_MENUS, ...ANALYTICS_MENUS, ...FARM_MENUS].flatMap((menu) => menu.groups.flatMap((group) => group.links.map((link) => iconForDestination(link.href)))));
    for (const name of routeIcons) if (name) expect(files, name).toContain(name);
    const normalise = (svg: string) => svg.replace(/<title>.*?<\/title>/, "").replace(/^[\s\S]*?<g /, "<g ").replace(/<\/svg>[\s\S]*$/, "").replace(/><\/(path|circle|rect|ellipse)>/g, "/>").replace(/\s+/g, " ").trim();
    for (const name of files) {
      const inline = renderToStaticMarkup(createElement(IllustratedIcon, { name: name as IllustratedIconName }));
      expect(normalise(inline), name).toBe(normalise(readFileSync(join(folder, `${name}.svg`), "utf8")));
    }
  });
});
