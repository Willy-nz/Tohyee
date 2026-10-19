import { describe, expect, it } from "vitest";
import {
  ALL_SETTINGS_HREF,
  destinations,
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

  it("follows the issue's grouping for the Accountant menu", () => {
    const accountant = visibleMenus("accounting", access("owner", everything)).find((menu) => menu.label === "Accountant")!;
    const shape = accountant.groups.map((group) => [group.heading, menuSections(group).map((section) => [section.heading, section.links.map((link) => link.label)])]);
    expect(shape).toEqual([
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
      [
        "Tax and R&D",
        [
          ["GST", ["GST return", "GST audit report", "Tax codes"]],
          ["Income tax", ["Income tax"]],
          ["R&D", ["R&D activities", "Tagged R&D costs", "R&D claim report"]],
        ],
      ],
      ["Settings", [[null, ["Organisation settings", "People and roles", "Email", "Sales platforms", "Import and export", "All settings"]]]],
    ]);
  });

  it("drops a section whose module is off, heading and all", () => {
    const accountant = visibleMenus("accounting", access("owner", { ...everything, livestock: false, gst: false })).find((menu) => menu.label === "Accountant")!;
    const headings = accountant.groups.flatMap((group) => menuSections(group).map((section) => section.heading));
    expect(headings).not.toContain("Livestock");
    expect(headings).toContain("GST"); // Tax codes stay without GST registration.
    const gst = accountant.groups.flatMap((group) => menuSections(group)).find((section) => section.heading === "GST")!;
    expect(gst.links.map((link) => link.label)).toEqual(["Tax codes"]);
  });

  it("names the sub-heading in the command palette's group", () => {
    const items = destinations(visibleMenus("accounting", access("owner", everything)), []);
    expect(items.find((item) => item.label === "GST return")?.group).toBe("Accountant › Tax and R&D › GST");
    expect(items.find((item) => item.label === "Journals")?.group).toBe("Accountant › Ledger");
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
    const old = MENUS.find((menu) => menu.label === "Accountant")!.groups.find((group) => group.heading === "Settings")!;
    for (const link of old.links) {
      const card = SETTINGS.flatMap((group) => group.links).find((setting) => setting.href === link.href);
      if (card) expect([card.minRole, card.module]).toEqual([link.minRole, link.module]);
    }
  });

  it("leaves the menu the most used settings and All settings", () => {
    const viewer = visibleMenus("accounting", access("viewer")).find((menu) => menu.label === "Accountant")!;
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
