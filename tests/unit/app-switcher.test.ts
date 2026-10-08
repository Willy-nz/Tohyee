import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSwitcher, availableApps } from "@/components/app-switcher";

/** The app switcher in both shells offers the CRM only while it's on for the organisation (MOD1). */
describe("app switcher", () => {
  const render = (current: "accounting" | "crm" | "analytics", modules: { crm: boolean; reporting: boolean; notForProfit: boolean; analytics: boolean; gst: boolean } | null) =>
    renderToStaticMarkup(createElement(AppSwitcher, { current, modules }));
  /** Each link's address, whether it's marked current, and its text. */
  const links = (html: string) =>
    [...html.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map(([, attributes, text]) => [
      /href="([^"]*)"/.exec(attributes)?.[1],
      /aria-current="page"/.test(attributes),
      text,
    ]);

  it("is hidden when the CRM is off, or while the modules are loading", () => {
    expect(availableApps({ crm: false, reporting: true, notForProfit: false, analytics: false, gst: true })).toEqual(["accounting"]);
    expect(render("accounting", { crm: false, reporting: true, notForProfit: false, analytics: false, gst: true })).toBe("");
    expect(render("crm", { crm: false, reporting: false, notForProfit: false, analytics: false, gst: true })).toBe("");
    expect(availableApps(null)).toEqual(["accounting"]);
    expect(render("accounting", null)).toBe("");
  });

  it("offers Accounting and the CRM when the CRM is on, marking the current one", () => {
    expect(availableApps({ crm: true, reporting: false, notForProfit: false, analytics: false, gst: true })).toEqual(["accounting", "crm"]);
    const inAccounting = render("accounting", { crm: true, reporting: false, notForProfit: false, analytics: false, gst: true });
    expect(inAccounting).toContain('aria-label="Apps"');
    expect(inAccounting).toContain("<summary");
    expect(links(inAccounting)).toEqual([
      ["/operations", true, "Accounting"],
      ["/crm", false, "CRM"],
    ]);
    expect(links(render("crm", { crm: true, reporting: false, notForProfit: false, analytics: false, gst: true }))).toEqual([
      ["/operations", false, "Accounting"],
      ["/crm", true, "CRM"],
    ]);
  });

  it("offers Analytics only while it's on (decision 353)", () => {
    expect(availableApps({ crm: false, reporting: false, notForProfit: false, analytics: true, gst: true })).toEqual(["accounting", "analytics"]);
    expect(links(render("analytics", { crm: true, reporting: false, notForProfit: false, analytics: true, gst: true }))).toEqual([
      ["/operations", false, "Accounting"],
      ["/crm", false, "CRM"],
      ["/analytics", true, "Analytics"],
    ]);
  });

  it("shows only Analytics to report viewers", () => {
    expect(availableApps({ crm: true, reporting: true, notForProfit: true, analytics: true, gst: true }, true)).toEqual(["analytics"]);
    expect(renderToStaticMarkup(createElement(AppSwitcher, { current: "analytics", modules: { crm: true, reporting: true, notForProfit: true, analytics: true, gst: true }, reportViewer: true }))).toBe("");
  });

  it("leaves Accounting out while it's off (#181, MOD2)", () => {
    expect(availableApps({ crm: true, reporting: false, notForProfit: false, analytics: false, gst: false, accounting: false })).toEqual(["crm"]);
    expect(availableApps({ crm: true, reporting: false, notForProfit: false, analytics: true, gst: false, accounting: false })).toEqual(["crm", "analytics"]);
  });
});
