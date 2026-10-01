import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSwitcher, availableApps } from "@/components/app-switcher";

/** The app switcher in both shells offers the CRM only while it's on for the organisation (MOD1). */
describe("app switcher", () => {
  const render = (current: "accounting" | "crm", modules: { crm: boolean; reporting: boolean } | null) =>
    renderToStaticMarkup(createElement(AppSwitcher, { current, modules }));
  /** Each link's address, whether it's marked current, and its text. */
  const links = (html: string) =>
    [...html.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map(([, attributes, text]) => [
      /href="([^"]*)"/.exec(attributes)?.[1],
      /aria-current="true"/.test(attributes),
      text,
    ]);

  it("is hidden when the CRM is off, or while the modules are loading", () => {
    expect(availableApps({ crm: false, reporting: true })).toEqual(["accounting"]);
    expect(render("accounting", { crm: false, reporting: true })).toBe("");
    expect(render("crm", { crm: false, reporting: false })).toBe("");
    expect(availableApps(null)).toEqual(["accounting"]);
    expect(render("accounting", null)).toBe("");
  });

  it("offers Accounting and the CRM when the CRM is on, marking the current one", () => {
    expect(availableApps({ crm: true, reporting: false })).toEqual(["accounting", "crm"]);
    const inAccounting = render("accounting", { crm: true, reporting: false });
    expect(inAccounting).toContain('aria-label="Apps"');
    expect(links(inAccounting)).toEqual([
      ["/operations", true, "Accounting"],
      ["/crm", false, "CRM"],
    ]);
    expect(links(render("crm", { crm: true, reporting: false }))).toEqual([
      ["/operations", false, "Accounting"],
      ["/crm", true, "CRM"],
    ]);
  });
});
