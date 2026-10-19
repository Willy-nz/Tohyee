import { describe, expect, it } from "vitest";
import { CRM_MENUS, destinations, inArea, MENUS, NEW_ACTIONS, searchDestinations, visibleMenus, visibleNewActions } from "@/components/navigation";
import { type Role, roleAtLeast } from "@/lib/auth/roles";

const access = (role: Role, modules: { crm: boolean; reporting: boolean; notForProfit: boolean; analytics: boolean; gst: boolean; accounting?: boolean } = { crm: false, reporting: false, notForProfit: false, analytics: false, gst: true }) => ({
  can: (wanted: Role) => roleAtLeast(role, wanted),
  modules,
});

/** The top bar's menus after the 2026 redesign: a few labelled groups each, creating things under "+ New". */
describe("top bar menus", () => {
  it("shows no Accounting menus or + New while Accounting is off (#181, MOD2)", () => {
    const off = access("owner", { crm: true, reporting: false, notForProfit: false, analytics: false, gst: false, accounting: false });
    expect(visibleMenus("accounting", off)).toEqual([]);
    expect(visibleNewActions(off)).toEqual([]);
    expect(visibleMenus("crm", off).length).toBeGreaterThan(0);
  });

  it("uses the simplified accounting menus", () => {
    expect(MENUS.map((menu) => menu.label)).toEqual(["Home", "Sales", "Purchases", "Banking", "Payroll", "Farm", "Reports", "Accountant"]);
  });

  it("shows the Farm menu only while Farming is on (#249)", () => {
    const access = (farming: boolean) => ({ can: () => true, modules: { crm: false, reporting: false, notForProfit: false, analytics: false, gst: false, farming } });
    expect(visibleMenus("accounting", access(false)).map((menu) => menu.label)).not.toContain("Farm");
    expect(visibleMenus("accounting", access(true)).map((menu) => menu.label)).toContain("Farm");
  });

  it("keeps every menu to at most four labelled groups, none empty", () => {
    for (const menu of MENUS) {
      expect(menu.groups.length).toBeLessThanOrEqual(4);
      for (const group of menu.groups) {
        expect(group.heading).not.toBe("");
        expect(group.links.length).toBeGreaterThan(0);
      }
    }
  });

  it("has no create links left in the menus: they're all under + New", () => {
    const menuLinks = MENUS.flatMap((menu) => menu.groups.flatMap((group) => group.links.map((link) => link.href)));
    for (const action of NEW_ACTIONS.flatMap((group) => group.links)) {
      expect(menuLinks).not.toContain(action.href);
    }
    expect(NEW_ACTIONS.flatMap((group) => group.links.map((link) => link.label))).toEqual([
      "New invoice",
      "New quote",
      "New sales order",
      "New credit note",
      "Receive a payment",
      "New project",
      "New bill",
      "New purchase order",
      "New supplier credit note",
      "Pay bills",
      "New expense claim",
    ]);
  });

  it("shows + New to bookkeepers and up, never to viewers", () => {
    expect(visibleNewActions(access("viewer"))).toEqual([]);
    expect(visibleNewActions(access("bookkeeper")).flatMap((group) => group.links)).toHaveLength(11);
  });

  it("still filters links by role and module", () => {
    const viewerLinks = visibleMenus("accounting", access("viewer")).flatMap((menu) => menu.groups.flatMap((group) => group.links));
    expect(viewerLinks.some((link) => link.label === "People and roles")).toBe(false);
    expect(viewerLinks.some((link) => link.label === "Sales by salesperson")).toBe(false);
    const adminWithModules = visibleMenus("accounting", access("admin", { crm: true, reporting: true, notForProfit: true, analytics: false, gst: true }));
    const labels = adminWithModules.flatMap((menu) => menu.groups.flatMap((group) => group.links.map((link) => link.label)));
    expect(labels).toEqual(expect.arrayContaining(["People and roles", "Sales by salesperson", "CRM record types", "Fund activity"]));
  });
});

describe("command palette search", () => {
  const items = destinations(visibleMenus("accounting", access("owner")), visibleNewActions(access("owner")));

  it("lists every menu destination and + New action", () => {
    expect(items.some((item) => item.label === "Chart of accounts" && item.group === "Accountant › Ledger")).toBe(true);
    expect(items.some((item) => item.label === "New invoice" && item.group === "New › Sales")).toBe(true);
    expect(items.some((item) => item.label === "Home" && item.href === "/operations")).toBe(true);
  });

  it("matches every word against the label or group, labels first", () => {
    const results = searchDestinations(items, "inv");
    expect(results[0].label.toLowerCase().startsWith("inv")).toBe(true);
    expect(searchDestinations(items, "ledger journals").map((item) => item.label)).toContain("Journals");
    expect(searchDestinations(items, "zzz")).toEqual([]);
    expect(searchDestinations(items, "")).toHaveLength(items.length);
  });
});

/** #342: the CRM's 17 tabs grouped into a short top bar (decision 581). */
describe("CRM top bar", () => {
  const crmOn = (role: Role, accounting = true) => access(role, { crm: true, reporting: false, notForProfit: false, analytics: false, gst: false, accounting });
  const links = (menus: ReturnType<typeof visibleMenus>) =>
    menus.flatMap((menu) => [...(menu.href ? [{ href: menu.href, label: menu.label }] : []), ...menu.groups.flatMap((group) => group.links)]);

  /** Every tab the CRM had before, with the role it needed. */
  const BEFORE: Array<[string, Role | undefined]> = [
    ["/crm", undefined],
    ["/crm/leads", undefined],
    ["/crm/campaigns", undefined],
    ["/crm/companies", undefined],
    ["/crm/people", undefined],
    ["/crm/pipeline", undefined],
    ["/crm/forecasts", undefined],
    ["/crm/dashboard", undefined],
    ["/crm/tasks", undefined],
    ["/crm/mail", undefined],
    ["/crm/teams", undefined],
    ["/crm/duplicates", undefined],
    ["/crm/follow-ups", "admin"],
    ["/crm/email-templates", "admin"],
    ["/crm/sequences", "admin"],
    ["/crm/record-types", "admin"],
    ["/crm/stages", "admin"],
  ];

  it("has seven places across the top, not seventeen", () => {
    expect(visibleMenus("crm", crmOn("owner")).map((menu) => menu.label)).toEqual(["Home", "Contacts", "Sales", "Tasks", "Dashboard", "More", "Settings"]);
  });

  it("keeps every page reachable, each needing the same role as before", () => {
    const all = CRM_MENUS.flatMap((menu) => [...(menu.href ? [{ href: menu.href, minRole: menu.minRole }] : []), ...menu.groups.flatMap((group) => group.links)]);
    for (const [href, role] of BEFORE) {
      const link = all.find((item) => item.href === href);
      expect(link, href).toBeDefined();
      expect(link?.minRole, href).toBe(role);
    }
    const ownerHrefs = links(visibleMenus("crm", crmOn("owner"))).map((link) => link.href);
    for (const [href] of BEFORE) expect(ownerHrefs).toContain(href);
    const viewerHrefs = links(visibleMenus("crm", crmOn("viewer"))).map((link) => link.href);
    for (const [href, role] of BEFORE) expect(viewerHrefs.includes(href), href).toBe(role === undefined);
  });

  it("links Integrations to the existing Sales platforms settings while Accounting is on", () => {
    const integration = (accounting: boolean, role: Role = "owner") =>
      links(visibleMenus("crm", crmOn(role, accounting))).find((link) => link.href === "/operations/settings/sales-platforms");
    expect(integration(true)?.label).toBe("Sales platforms (Shopify)");
    expect(integration(false)).toBeUndefined();
    // Sales reps have the CRM only: their modules say Accounting is off (decision 491).
    expect(integration(false, "sales_rep")).toBeUndefined();
    const settings = visibleMenus("crm", crmOn("owner")).find((menu) => menu.label === "Settings")!;
    expect(settings.groups.map((group) => group.heading)).toEqual(["Team and data", "Customise", "Integrations"]);
  });

  it("shows a dropdown as current on any of its pages", () => {
    const menu = (label: string) => CRM_MENUS.find((item) => item.label === label)!;
    expect(inArea("/crm/opportunities/abc", menu("Sales"))).toBe(true);
    expect(inArea("/crm/companies/abc", menu("Contacts"))).toBe(true);
    expect(inArea("/crm/sequences", menu("More"))).toBe(true);
    expect(inArea("/crm/stages", menu("Settings"))).toBe(true);
    expect(inArea("/crm/leads", menu("Home"))).toBe(false);
  });

  it("drops a dropdown that has nothing left in it", () => {
    const menus = visibleMenus("crm", { can: () => false, modules: { crm: true, reporting: false, notForProfit: false, analytics: false, gst: false, accounting: false } });
    for (const menu of menus) expect(Boolean(menu.href) || menu.groups.length > 0).toBe(true);
  });
});
