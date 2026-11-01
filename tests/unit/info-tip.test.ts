import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InfoPara, InfoTip } from "@/components/info-tip";
import { INFO_TIP_MARGIN, placeInfoTip } from "@/lib/ui/info-tip";

const box = (left: number, top: number) => ({ left, top, right: left + 22, bottom: top + 22 });

describe("placeInfoTip (decision 1210)", () => {
  it("opens below the button at its full width on a wide screen", () => {
    const p = placeInfoTip(box(200, 100), { width: 1280, height: 800 });
    expect(p).toMatchObject({ side: "below", width: 360, left: 188, top: 128 });
    expect(p.maxHeight).toBe(800 - 122 - 6 - INFO_TIP_MARGIN);
  });

  it("stays on a 390px phone screen, even for a button at the right edge", () => {
    const p = placeInfoTip(box(360, 100), { width: 390, height: 844 });
    expect(p.width).toBe(360);
    expect(p.left).toBeGreaterThanOrEqual(INFO_TIP_MARGIN);
    expect(p.left + p.width).toBeLessThanOrEqual(390 - INFO_TIP_MARGIN);
  });

  it("narrows to the screen when the screen is narrower than the panel", () => {
    const p = placeInfoTip(box(5, 100), { width: 320, height: 600 });
    expect(p.width).toBe(304);
    expect(p.left).toBe(INFO_TIP_MARGIN);
  });

  it("opens above when the button is near the bottom and there's more room above", () => {
    const p = placeInfoTip(box(100, 760), { width: 1280, height: 800 });
    expect(p.side).toBe("above");
    expect(p.top).toBe(754);
    expect(p.maxHeight).toBe(760 - 6 - INFO_TIP_MARGIN);
  });

  it("is never taller than the room below on a very short window (issue #523)", () => {
    const p = placeInfoTip({ left: 100, top: 60, right: 122, bottom: 82 }, { width: 320, height: 150 });
    expect(p.side).toBe("below");
    expect(p.top).toBe(88);
    expect(p.maxHeight).toBe(150 - 82 - 6 - INFO_TIP_MARGIN);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(150 - INFO_TIP_MARGIN);
  });

  it("is never taller than the room above when it opens above (issue #523)", () => {
    const p = placeInfoTip({ left: 100, top: 100, right: 122, bottom: 122 }, { width: 320, height: 140 });
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(100 - 6 - INFO_TIP_MARGIN);
    expect(p.top - p.maxHeight).toBeGreaterThanOrEqual(INFO_TIP_MARGIN);
  });

  it("never gives a negative height when there's no room at all", () => {
    const p = placeInfoTip({ left: 10, top: 2, right: 32, bottom: 24 }, { width: 320, height: 26 });
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it("keeps the panel inside the visible part of a pinch-zoomed page", () => {
    // Visible area is 200x300, scrolled 400 across and 1000 down the layout viewport.
    const p = placeInfoTip({ left: 560, top: 1100, right: 582, bottom: 1122 }, { width: 200, height: 300, left: 400, top: 1000 });
    expect(p.left).toBeGreaterThanOrEqual(400 + INFO_TIP_MARGIN);
    expect(p.left + p.width).toBeLessThanOrEqual(600 - INFO_TIP_MARGIN);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(1300 - INFO_TIP_MARGIN);
  });

  it("stays below when there's enough room there", () => {
    expect(placeInfoTip(box(100, 500), { width: 1280, height: 800 }).side).toBe("below");
  });
});

describe("InfoTip", () => {
  const html = renderToStaticMarkup(
    createElement("p", null, "Short line. ", createElement(InfoTip, { label: "Tax codes" }, "The full explanation.", createElement(InfoPara, null, "Second part."))),
  );

  it("is a closed disclosure button tied to its text", () => {
    expect(html).toContain('aria-expanded="false"');
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    expect(html).toContain('type="button"');
    expect(html).toContain("More about Tax codes");
  });

  it("keeps the full text in the page (for print and search) and only uses inline elements inside a <p>", () => {
    expect(html).toContain("The full explanation.");
    expect(html).toContain("Second part.");
    expect(html).not.toContain("<div");
    expect(html.match(/<p[ >]/g)).toHaveLength(1);
  });
});
