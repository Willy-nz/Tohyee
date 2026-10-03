import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSwitcher, availableApps } from "@/components/app-switcher";

/** The app switcher in both shells offers the CRM only while it's on for the organisation (MOD1). */
describe("app switcher", () => {
  const render = (current: "accounting" | "crm" | "analytics", modules: { crm: boolean; reporting: boolean; notForProfit: boolean; analytics: boolean } | null) =>
    renderToStaticMarkup(createElement(AppSwitcher, { current, modules }));
  /** Each link's address, whether it's marked current, and its text. */
  const links = (html: string) =>
    [...html.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map(([, attributes, text]) => [
      /href="([^"]*)"/.exec(attributes)?.[1],
      /aria-current="true"/.test(attributes),
      text,
    ]);

  it("is hidden when the CRM is off, or while the modules are loading", () => {
    expect(availableApps({ crm: false, reporting: true, notForProfit: false, analytics: false })).toEqual(["accounting"]);
    expect(render("accounting", { crm: false, reporting: true, notForProfit: false, analytics: false })).toBe("");
    expect(render("crm", { crm: false, reporting: false, notForProfit: false, analytics: false })).toBe("");
    expect(availableApps(null)).toEqual(["accounting"]);
    expect(render("accounting", null)).toBe("");
  });

  it("offers Accounting and the CRM when the CRM is on, marking the current one", () => {
    expect(availableApps({ crm: true, reporting: false, notForProfit: false, analytics: false })).toEqual(["accounting", "crm"]);
    const inAccounting = render("accounting", { crm: true, reporting: false, notForProfit: false, analytics: false });
    expect(inAccounting).toContain('aria-label="Apps"');
    expect(links(inAccounting)).toEqual([
      ["/operations", true, "Accounting"],
      ["/crm", false, "CRM"],
    ]);
    expect(links(render("crm", { crm: true, reporting: false, notForProfit: false, analytics: false }))).toEqual([
      ["/operations", false, "Accounting"],
      ["/crm", true, "CRM"],
    ]);
  });

  it("offers Analytics only while it's on (decision 353)", () => {
    expect(availableApps({ crm: false, reporting: false, notForProfit: false, analytics: true })).toEqual(["accounting", "analytics"]);
    expect(links(render("analytics", { crm: true, reporting: false, notForProfit: false, analytics: true }))).toEqual([
      ["/operations", false, "Accounting"],
      ["/crm", false, "CRM"],
      ["/analytics", true, "Analytics"],
    ]);
  });
});
