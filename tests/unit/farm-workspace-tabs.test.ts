import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The farm tabs at the bottom of a phone's screen (#447, decision 1046;
 * #498 item 2, decision 1111): drawn by the farm pages' shared layout, so
 * every farm page has them; a field or button the browser scrolls into
 * view stops above them; and the page leaves room under its last button
 * for them and the phone's own bar.
 */
describe("the farm tabs on a phone", () => {
  const css = readFileSync(new URL("../../src/components/farm-frame.module.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 700px)"));
  it("sit at the bottom of the screen, above the phone's own bar", () => {
    expect(phone).toMatch(/\.tabs \{[^}]*position: fixed;[^}]*bottom: 0;[^}]*padding: [^;]*env\(safe-area-inset-bottom\)/);
  });
  it("leave room above them when the browser scrolls something into view", () => {
    const rule = /:global\(html\):has\(\.frame\) \{\s*scroll-padding-bottom: calc\((\d+)px \+ env\(safe-area-inset-bottom\)\);/.exec(phone);
    expect(rule).not.toBeNull();
    // At least the tabs' height: 56px tabs, 4px padding each side and the top border.
    expect(Number(rule![1])).toBeGreaterThanOrEqual(66);
  });
  it("never cover the end of a page", () => {
    const rule = /\.frame \{\s*padding-bottom: calc\((\d+)px \+ env\(safe-area-inset-bottom\)\);/.exec(phone);
    expect(rule).not.toBeNull();
    expect(Number(rule![1])).toBeGreaterThanOrEqual(66);
  });
  it("come from the shared layouts of both farm folders, not each page", () => {
    for (const folder of ["farm", "farming"]) {
      const layout = readFileSync(new URL(`../../src/app/operations/${folder}/layout.tsx`, import.meta.url), "utf8");
      expect(layout).toContain("<FarmFrame>");
    }
    const workspace = readFileSync(new URL("../../src/components/farm-workspace.tsx", import.meta.url), "utf8");
    expect(workspace).not.toContain('aria-label="Farm"');
  });
});
