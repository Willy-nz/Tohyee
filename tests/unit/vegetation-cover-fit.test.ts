import { describe, expect, it } from "vitest";
import { type CoverPair, fitLine, modelledCover, predict, seasonOf, summarise, validate } from "@/lib/farming/vegetation/cover-fit";

/** MCV1-MCV8 in docs/ACCOUNTING-EXAMPLES.md (#612 phase 3; not yet reviewed). Made-up readings. */
const pair = (sceneId: string, imageOn: string, ndvi: string, cover: number, farmId = "1", paddockId = "1"): CoverPair => ({ farmId, paddockId, sceneId, imageOn, measuredOn: imageOn, ndvi, cover });

/** MCV3's farm: 16 readings on 4 dates; cover = 500 + 3000 × NDVI, give or take. */
function farmA(): CoverPair[] {
  const out: CoverPair[] = [];
  const dates: Array<[string, string]> = [
    ["s1", "2026-01-10"],
    ["s2", "2026-04-12"],
    ["s3", "2026-07-15"],
    ["s4", "2026-10-20"],
  ];
  const ndvis = ["0.40", "0.55", "0.70", "0.85"];
  const noise = [40, -40, 20, -20];
  dates.forEach(([sceneId, on], d) => ndvis.forEach((ndvi, i) => out.push(pair(sceneId, on, ndvi, 500 + 3000 * Number(ndvi) + noise[(i + d) % 4], "1", String(i + 1)))));
  return out;
}

describe("modelled pasture cover", () => {
  it("MCV1: a straight line through readings, exactly", () => {
    expect(fitLine([pair("a", "2026-01-01", "0.50", 2000), pair("b", "2026-01-02", "0.70", 2600)])).toEqual({ intercept: "500.0000", slope: "3000.0000" });
    expect(fitLine([pair("a", "2026-01-01", "0.50", 2000), pair("b", "2026-01-02", "0.50", 2600)])).toBeNull();
    expect(predict({ intercept: "500", slope: "3000" }, "0.6123")).toBe(2340);
    expect(predict({ intercept: "-900", slope: "1000" }, "0.5")).toBe(0);
  });

  it("MCV4: not offered until there are 12 readings on 4 dates", () => {
    const few = farmA().filter((p) => p.sceneId !== "s4");
    expect(validate(few)).toMatchObject({ line: null, pairs: 12, dates: 3 });
    expect(validate(few).notReady).toContain("So far: 12 on 3.");
  });

  it("MCV3, MCV5: checked on dates it wasn't fitted on, by season, and on other farms", () => {
    const result = validate(farmA());
    expect(result.notReady).toBeNull();
    expect(result.line).toEqual({ intercept: "500.0000", slope: "3000.0000" });
    expect(result.ndviRange).toEqual({ min: "0.4000", max: "0.8500" });
    // Left out, a date is predicted by a line fitted to the other three; rounding to ten adds a little.
    expect(result.withheldDates).toEqual({ pairs: 16, meanError: 34, bias: 0, likelyWithin: 50 });
    expect(result.bySeason.map((row) => row.season)).toEqual(["summer", "autumn", "winter", "spring"]);
    // Another farm reads 300 higher at the same greenness: this farm's readings come out 300 high on its line.
    const other = farmA().map((p) => ({ ...p, farmId: "2", cover: p.cover + 300 }));
    expect(validate(farmA(), other).otherFarms).toMatchObject({ pairs: 16, bias: 300 });
  });

  it("MCV5: seasons as New Zealand counts them", () => {
    expect(["2026-12-01", "2026-02-28", "2026-03-01", "2026-06-01", "2026-09-30"].map(seasonOf)).toEqual(["summer", "summer", "autumn", "winter", "spring"]);
  });

  it("MCV6: an estimate's band, never below nothing, flagged outside what it was checked on", () => {
    const model = { line: { intercept: "500", slope: "3000" }, likelyWithin: 250, ndviMin: "0.40", ndviMax: "0.85" };
    expect(modelledCover(model, "0.60")).toEqual({ cover: 2300, low: 2050, high: 2550, outsideRange: false });
    expect(modelledCover(model, "0.20")).toMatchObject({ cover: 1100, outsideRange: true });
    expect(summarise([])).toBeNull();
    expect(summarise([{ predicted: 100, measured: 0 }, { predicted: 0, measured: 300 }])).toEqual({ pairs: 2, meanError: 200, bias: -100, likelyWithin: 300 });
  });
});
