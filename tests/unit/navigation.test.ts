import { describe, expect, it } from "vitest";
import { destinations, MENUS, NEW_ACTIONS, searchDestinations, visibleMenus, visibleNewActions } from "@/components/navigation";
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
    expect(MENUS.map((menu) => menu.label)).toEqual(["Home", "Sales", "Purchases", "Banking", "Payroll", "Reports", "Accountant"]);
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
