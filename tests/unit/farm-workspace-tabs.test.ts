import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The farm tabs at the bottom of a phone's screen (#447, decision 1046):
 * found testing the phone app, a field or button the browser scrolled into
 * view (moving with the keyboard, or a form opening) stopped behind the
 * tabs. The page keeps room for them when it scrolls something into view.
 */
describe("the farm tabs on a phone", () => {
  const css = readFileSync(new URL("../../src/components/farm-workspace.module.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 700px)"));
  it("sit at the bottom of the screen", () => {
    expect(phone).toMatch(/\.tabs \{[^}]*position: fixed;[^}]*bottom: 0;/);
  });
  it("leave room above them when the browser scrolls something into view", () => {
    const rule = /:global\(html\):has\(\.workspace\) \{\s*scroll-padding-bottom: calc\((\d+)px \+ env\(safe-area-inset-bottom\)\);/.exec(phone);
    expect(rule).not.toBeNull();
    // At least the tabs' height: 56px tabs, 4px padding each side and the top border.
    expect(Number(rule![1])).toBeGreaterThanOrEqual(66);
  });
});
