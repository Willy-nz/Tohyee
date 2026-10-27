import { describe, expect, it } from "vitest";
import {
  ALL_SETTINGS_HREF,
  CRM_MENUS,
  destinations,
  farmWorkAllowsPath,
  inArea,
  menuSections,
  MENUS,
  NEW_ACTIONS,
  SETTINGS,
  searchDestinations,
  visibleMenus,
  visibleNewActions,
  visibleSettings,
} from "@/components/navigation";
import type { Modules } from "@/components/modules";
import { type Role, roleAtLeast } from "@/lib/auth/roles";

const access = (role: Role, modules: Modules = { crm: false, reporting: false, notForProfit: false, analytics: false, gst: true }) => ({
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
    expect(MENUS.map((menu) => menu.label)).toEqual(["Home", "Sales", "Purchases", "Banking", "Payroll", "Farm", "Reports", "Accounting", "Tax", "Settings"]);
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
    expect(labels).toEqual(expect.arrayContaining(["People and roles", "Sales by salesperson", "Fund activity"]));
    const settingLabels = visibleSettings(access("admin", { crm: true, reporting: true, notForProfit: true, analytics: false, gst: true })).flatMap((group) =>
      group.links.map((link) => link.label),
    );
    expect(settingLabels).toEqual(expect.arrayContaining(["People and roles", "CRM record types", "Tracking categories"]));
    expect(visibleSettings(access("viewer")).flatMap((group) => group.links.map((link) => link.label))).not.toContain("People and roles");
  });
});

const everything = { crm: true, reporting: true, notForProfit: true, analytics: true, gst: true, livestock: true, farming: true };

/** #338: long columns get grey sub-headings, so each run of links is short (decision 580). */
describe("menu sub-headings", () => {
  it("splits every column of more than seven links into sections of at most six", () => {
    for (const menu of visibleMenus("accounting", access("owner", everything))) {
      for (const group of menu.groups) {
        const sections = menuSections(group);
        if (group.links.length > 7) expect(sections.every((section) => section.heading !== null), `${menu.label} › ${group.heading}`).toBe(true);
        for (const section of sections) {
          expect(section.links.length, `${menu.label} › ${group.heading} › ${section.heading}`).toBeLessThanOrEqual(section.heading ? 6 : 7);
        }
      }
    }
  });

  it("keeps each section's links together, so a sub-heading appears once per column", () => {
    for (const menu of MENUS) {
      for (const group of menu.groups) {
        const headings = menuSections(group).map((section) => section.heading);
        expect(new Set(headings).size, `${menu.label} › ${group.heading}`).toBe(headings.length);
      }
    }
  });

  it("splits the old Accountant menu into Accounting, Tax and Settings dropdowns (#375, decision 700)", () => {
    const menus = visibleMenus("accounting", access("owner", everything));
    const shape = (label: string) => {
      const menu = menus.find((entry) => entry.label === label)!;
      expect(menu.href, label).toBeUndefined(); // a dropdown, not a link to a landing page
      return menu.groups.map((group) => [group.heading, menuSections(group).map((section) => [section.heading, section.links.map((link) => link.label)])]);
    };
    expect(shape("Accounting")).toEqual([
      [
        "Ledger",
        [
          ["Ledger", ["Journals", "Chart of accounts"]],
          ["Year end", ["Period close", "Year-end pack", "Financial statements"]],
          ["Inventory", ["Products and services", "Stock"]],
        ],
      ],
      [
        "Assets",
        [
          ["Fixed assets", ["Fixed assets", "Depreciation"]],
          ["Livestock", ["Livestock", "Account sales", "Livestock valuation", "Livestock management values"]],
        ],
      ],
    ]);
    // One short column.
    expect(shape("Tax")).toEqual([
      [
        "Tax",
        [
          ["GST", ["GST return", "GST audit report", "Tax codes"]],
          ["Income tax", ["Income tax"]],
          ["R&D", ["R&D activities", "Tagged R&D costs", "R&D claim report"]],
        ],
      ],
    ]);
    // Decision 580's five most used settings and All settings, unchanged.
    expect(shape("Settings")).toEqual([["Settings", [[null, ["Organisation settings", "People and roles", "Email", "Sales platforms", "Import and export", "All settings"]]]]]);
  });

  it("keeps the Accountant menu's links, roles and modules (#375)", () => {
    const links = MENUS.filter((menu) => ["Accounting", "Tax", "Settings"].includes(menu.label)).flatMap((menu) => menu.groups.flatMap((group) => group.links));
    expect(links.find((link) => link.href === "/operations/income-tax")?.minRole).toBe("admin");
    expect(links.find((link) => link.href === "/operations/gst-return")?.module).toBe("gst");
    expect(links.find((link) => link.href === "/operations/livestock")?.module).toBe("livestock");
    expect(links.find((link) => link.href === "/operations/settings/sales-platforms")?.minRole).toBeUndefined();
    expect(links).toHaveLength(26);
  });

  it("shows each new menu as current on its own pages (#375)", () => {
    const menu = (label: string) => MENUS.find((entry) => entry.label === label)!;
    expect(inArea("/operations/income-tax/payments", menu("Tax"))).toBe(true);
    expect(inArea("/operations/income-tax/payments", menu("Accounting"))).toBe(false);
    expect(inArea("/operations/fixed-assets/depreciation", menu("Accounting"))).toBe(true);
    expect(inArea(ALL_SETTINGS_HREF, menu("Settings"))).toBe(true);
    expect(inArea("/operations/members", menu("Settings"))).toBe(true);
  });

  it("hides Income tax from someone below admin, leaving the rest of Tax", () => {
    const tax = visibleMenus("accounting", access("bookkeeper", everything)).find((menu) => menu.label === "Tax")!;
    const labels = tax.groups.flatMap((group) => group.links.map((link) => link.label));
    expect(labels).not.toContain("Income tax");
    expect(labels).toContain("GST return");
  });

  it("drops a section whose module is off, heading and all", () => {
    const accountant = { groups: visibleMenus("accounting", access("owner", { ...everything, livestock: false, gst: false })).flatMap((menu) => menu.groups) };
    const headings = accountant.groups.flatMap((group) => menuSections(group).map((section) => section.heading));
    expect(headings).not.toContain("Livestock");
    expect(headings).toContain("GST"); // Tax codes stay without GST registration.
    const gst = accountant.groups.flatMap((group) => menuSections(group)).find((section) => section.heading === "GST")!;
    expect(gst.links.map((link) => link.label)).toEqual(["Tax codes"]);
  });

  it("names the sub-heading in the command palette's group", () => {
    const items = destinations(visibleMenus("accounting", access("owner", everything)), []);
    expect(items.find((item) => item.label === "GST return")?.group).toBe("Tax › GST");
    expect(items.find((item) => item.label === "Journals")?.group).toBe("Accounting › Ledger");
  });
});

describe("All settings page (decision 580)", () => {
  /** What the Accountant menu's Settings column listed before #338. */
  const OLD_SETTINGS = [
    "/operations/settings",
    "/operations/members",
    "/operations/settings/customers",
    "/operations/settings/email",
    "/operations/settings/import",
    "/operations/settings/tracking",
    "/operations/settings/custom-fields",
    "/operations/settings/salespeople",
    "/operations/settings/sales-platforms",
    "/operations/fixed-assets/types",
    "/operations/livestock/settings",
    "/operations/settings/bank-files",
    "/operations/settings/kilometre-rates",
    "/operations/settings/online-payments",
    "/operations/settings/approval-rules",
    "/operations/settings/payroll-access",
    "/crm/record-types",
    "/crm/stages",
  ];

  it("keeps every old setting reachable from the page", () => {
    const hrefs = SETTINGS.flatMap((group) => group.links.map((link) => link.href));
    for (const href of OLD_SETTINGS) expect(hrefs).toContain(href);
  });

  it("has cards of two to six links, with the same role and module rules as the menu", () => {
    for (const group of SETTINGS) {
      expect(group.links.length, group.heading).toBeGreaterThanOrEqual(2);
      expect(group.links.length, group.heading).toBeLessThanOrEqual(6);
    }
    const old = MENUS.find((menu) => menu.label === "Settings")!.groups.find((group) => group.heading === "Settings")!;
    for (const link of old.links) {
      const card = SETTINGS.flatMap((group) => group.links).find((setting) => setting.href === link.href);
      if (card) expect([card.minRole, card.module]).toEqual([link.minRole, link.module]);
    }
  });

  it("leaves the menu the most used settings and All settings", () => {
    const viewer = visibleMenus("accounting", access("viewer")).find((menu) => menu.label === "Settings")!;
    expect(viewer.groups.find((group) => group.heading === "Settings")!.links.map((link) => link.href)).toEqual(["/operations/settings/sales-platforms", ALL_SETTINGS_HREF]);
  });

  it("hides cards whose module is off, and the whole page while Accounting is off", () => {
    expect(visibleSettings(access("owner")).map((group) => group.heading)).not.toContain("CRM");
    expect(visibleSettings(access("owner", everything)).map((group) => group.heading)).toContain("CRM");
    expect(visibleSettings(access("owner", { ...everything, accounting: false }))).toEqual([]);
  });
});

describe("command palette search", () => {
  const items = destinations(visibleMenus("accounting", access("owner")), visibleNewActions(access("owner")));

  it("lists every menu destination and + New action", () => {
    expect(items.some((item) => item.label === "Chart of accounts" && item.group === "Accounting › Ledger")).toBe(true);
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

describe("farm staff (decision 904)", () => {
  const modules = { crm: false, reporting: false, notForProfit: false, analytics: false, gst: false, livestock: false, farming: true };
  const access = { can: () => false, modules, farmWorker: true };
  it("have the field-work pages only, nothing to make and no settings", () => {
    const menus = visibleMenus("accounting", access);
    expect(menus.map((menu) => menu.label)).toEqual(["Farm"]);
    expect(menus[0].groups.flatMap((group) => group.links.map((link) => link.href))).toEqual([
      "/operations/farm",
      "/operations/farming/pasture",
      "/operations/farming",
      "/operations/farming/soil",
      "/operations/farming/calendar",
      "/operations/farming/apps",
    ]);
    expect(visibleNewActions(access)).toEqual([]);
    expect(visibleSettings(access)).toEqual([]);
    expect(visibleMenus("crm", access)).toEqual([]);
  });
  it("are sent back to farm pages from anywhere else", () => {
    expect(farmWorkAllowsPath("/operations/farming")).toBe(true);
    expect(farmWorkAllowsPath("/operations/farming/pasture")).toBe(true);
    expect(farmWorkAllowsPath("/operations/profile")).toBe(true);
    expect(farmWorkAllowsPath("/operations/farm/map")).toBe(true);
    for (const path of ["/operations", "/operations/invoices", "/operations/farming/benchmarks", "/operations/farming/fertiliser", "/operations/farming/notebook", "/operations/livestock"]) expect(farmWorkAllowsPath(path)).toBe(false);
  });
});
