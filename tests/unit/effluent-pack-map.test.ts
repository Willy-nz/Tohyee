import { describe, expect, it } from "vitest";
import { appliedAreasSvg, shadeFor } from "@/lib/effluent/pack-map";

/** The council pack's map of applied areas (#487, decision 1099b). */
describe("effluent pack map", () => {
  it("shades by applications, darkest at five or more", () => {
    expect(shadeFor(0)).toBe("#f2f5ef");
    expect(shadeFor(5)).toBe(shadeFor(9));
    expect(shadeFor(1)).not.toBe(shadeFor(2));
  });

  it("draws paddocks, zones and points, escaping names, and says when there's nothing to draw", () => {
    const svg = appliedAreasSvg({
      title: "Effluent <applied>",
      paddocks: [{ name: "A&B", applications: 2, geometry: { type: "Polygon", coordinates: [[[170, -45], [170.01, -45], [170.01, -45.01], [170, -45]]] } }],
      zones: [{ name: "Bore", ring: null, point: [170.005, -45.005] }],
      points: [[170.002, -45.002]],
    });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain("A&amp;B (2)");
    expect(svg).toContain("Effluent &lt;applied&gt;");
    expect(svg).toContain("<circle");
    expect(svg).toContain("not a survey");
    expect(appliedAreasSvg({ title: "x", paddocks: [], zones: [], points: [] })).toContain("No paddock shapes to draw.");
  });
});
