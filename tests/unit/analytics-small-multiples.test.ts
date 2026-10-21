import { describe, expect, it } from "vitest";
import { parseChartFormat } from "@/lib/analytics/chart-format";
import type { ChartSpec } from "@/lib/analytics/chart-spec";
import { additiveValues, facetSpec, seriesSwatch, smallMultiples } from "@/lib/analytics/small-multiples";

const spec: ChartSpec = { kind: "column", category: "category", detail: "breakdown", series: [{ field: "m0", label: "Sales" }], valueFormat: "number" };

// Months across, a chart per region; made-up figures.
const rows = [
  { category: "2026-01-01", breakdown: "Otago", m0: "0.10" },
  { category: "2026-02-01", breakdown: "Otago", m0: "0.20" },
  { category: "2026-01-01", breakdown: "Canterbury", m0: "50" },
  { category: "2026-02-01", breakdown: "Waikato", m0: "7" },
  { category: "2026-01-01", breakdown: "Nelson", m0: "0.05" },
  { category: "2026-02-01", breakdown: "Nelson", m0: "0.25" },
];

describe("small multiples", () => {
  it("makes one chart per value with the same groups along the axis and one scale", () => {
    const result = smallMultiples(rows, spec, { additive: [true] });
    expect(result.facets.map((facet) => facet.name)).toEqual(["Otago", "Canterbury", "Waikato", "Nelson"]);
    // Every chart has both months, blank where it has nothing.
    expect(result.facets[1].rows).toEqual([
      { category: "2026-01-01", m0: "50" },
      { category: "2026-02-01", m0: null },
    ]);
    expect(result.folded).toBe(0);
    expect([result.min, result.max]).toEqual([0, 50]);
  });

  it("keeps the largest past the cap and adds the rest up exactly as Other", () => {
    const result = smallMultiples(rows, spec, { max: 3, additive: [true] });
    // Canterbury (50) and Waikato (7) are largest; Otago (0.3) and Nelson (0.3) become Other, in the answer's order.
    expect(result.facets.map((facet) => facet.name)).toEqual(["Canterbury", "Waikato", "Other"]);
    expect(result.facets[2]).toEqual({
      name: "Other",
      other: true,
      rows: [
        { category: "2026-01-01", m0: "0.15" },
        // 0.20 + 0.25 is exactly 0.45.
        { category: "2026-02-01", m0: "0.45" },
      ],
    });
    expect(result.folded).toBe(2);
    expect(result.omitted).toBe(false);
  });

  it("leaves the rest out when the values can't be added (an average)", () => {
    const result = smallMultiples(rows, spec, { max: 3, additive: additiveValues([{ aggregate: "avg" }]) });
    expect(result.facets.map((facet) => facet.name)).toEqual(["Canterbury", "Waikato"]);
    expect(result.omitted).toBe(true);
  });

  it("shares a scale that fits stacks and amounts below zero", () => {
    const two: ChartSpec = { ...spec, series: [{ field: "m0", label: "A" }, { field: "m1", label: "B" }], stacked: true };
    const result = smallMultiples(
      [
        { category: "x", breakdown: "One", m0: "30", m1: "45" },
        { category: "x", breakdown: "Two", m0: "-12", m1: "5" },
      ],
      two,
      { additive: [true, true], format: { stack: "stacked" } },
    );
    expect([result.min, result.max]).toEqual([-12, 80]);
  });

  it("gives each small chart the shared scale and no legend of its own (one sits above them)", () => {
    const result = smallMultiples(rows, spec, { additive: [true] });
    const first = facetSpec({ ...spec, format: { legend: { position: "bottom" } } }, result, 0);
    const second = facetSpec(spec, result, 1);
    expect(first.detail).toBeUndefined();
    expect(first.format?.valueAxis?.max).toBe("50");
    expect(first.format?.legend).toEqual({ position: "bottom", show: "hide" });
    expect(second.format?.legend?.show).toBe("hide");
    expect(seriesSwatch(undefined, 1)).toBe("var(--chart-2)");
    expect(seriesSwatch({ palette: "warm" }, 0)).toBe("var(--chart-2)");
    expect(seriesSwatch({ series: [{ hex: "#123456" }] }, 0)).toMatch(/^light-dark\(#123456, #[0-9a-f]{6}\)$/);
    // A range the tile chose itself wins.
    expect(facetSpec({ ...spec, format: { valueAxis: { max: "999" } } }, result, 0).format?.valueAxis?.max).toBe("999");
  });

  it("keeps the cap between 2 and 12", () => {
    expect(parseChartFormat({ smallMultiples: { max: 4 } })).toEqual({ smallMultiples: { max: 4 } });
    expect(() => parseChartFormat({ smallMultiples: { max: 20 } })).toThrow(/2 to 12/);
  });
});
