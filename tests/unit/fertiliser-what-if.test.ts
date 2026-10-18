import { describe, expect, it } from "vitest";
import { fertiliserWhatIf, parseWhatIf } from "@/lib/farming/fertiliser-what-if";

const urea = { name: "Urea", nPct: "46.00", pPct: "0.00", kPct: "0.00", sPct: "0.00" };

describe("a fertiliser application worked out, saving nothing (AIW12, not yet reviewed)", () => {
  it("matches FB2's plan line for paddock 12", () => {
    expect(fertiliserWhatIf({ ...parseWhatIf({ hectares: "20.0", kgPerHa: "100", pricePerTonne: "780", spreadingPerHa: "25" }), product: urea })).toEqual({
      product: "Urea",
      hectares: "20.00",
      kgPerHa: "100.00",
      tonnes: "2.000",
      kgPerHaOf: { n: "46.0", p: "0.0", k: "0.0", s: "0.0" },
      totalKgOf: { n: "920.0", p: "0.0", k: "0.0", s: "0.0" },
      productCost: "1560.00",
      spreadingCost: "500.00",
      total: "2060.00",
      saved: false,
    });
  });

  it("works without prices, and refuses a rate that isn't a number", () => {
    expect(fertiliserWhatIf({ ...parseWhatIf({ hectares: "15", kgPerHa: "80" }), product: urea })).toMatchObject({ tonnes: "1.200", kgPerHaOf: { n: "36.8" }, totalKgOf: { n: "552.0" }, productCost: null, spreadingCost: null, total: null });
    expect(() => parseWhatIf({ hectares: "15", kgPerHa: "lots" })).toThrow();
  });
});
