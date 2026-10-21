import { describe, expect, it } from "vitest";
import { compareFarms, type ComparisonInput } from "@/lib/farming/comparison-rules";

const reading = (paddockId: string, measuredOn: string, cover: number) => ({ id: `r${paddockId}`, paddockId, measuredOn, cover, method: "plate_meter" as const });

/** PF9 (docs/ACCOUNTING-EXAMPLES.md): two made-up farms compared on 22 October 2026. */
const farms: ComparisonInput[] = [
  {
    farmId: "1",
    farmName: "Home farm",
    effectiveHa: "23.00",
    mappedHa: "23.40",
    paddocks: [
      { paddockId: "11", name: "A", hectares: "10.00", latest: reading("11", "2026-10-15", 2500) },
      { paddockId: "12", name: "B", hectares: "5.00", latest: reading("12", "2026-10-20", 1900) },
      { paddockId: "13", name: "C", hectares: "8.00", latest: null },
    ],
    plan: { planId: "7", planName: "Home 2026-27", plannedTonnes: "12.500", appliedTonnes: "4.000", applications: 2, lastAppliedOn: "2026-09-30" },
  },
  {
    farmId: "2",
    farmName: "Runoff",
    effectiveHa: "42.00",
    mappedHa: "41.80",
    paddocks: [
      { paddockId: "21", name: "A", hectares: "40.00", latest: reading("21", "2026-09-01", 2000) },
      { paddockId: "22", name: "B", hectares: "2.00", latest: null },
    ],
    plan: null,
  },
];

describe("PF9 all farms compared", () => {
  const result = compareFarms("2026-10-22", farms);
  it("works each farm's cover as PF3 does, with its source dates and freshness", () => {
    expect(result.farms[0].pasture).toMatchObject({ averageKgDmPerHa: 2300, totalKgDm: 34500, measuredHa: "15.00", noReading: 1, oldestReading: "2026-10-15", newestReading: "2026-10-20", daysSinceNewest: 2, fresh: true });
    expect(result.farms[1].pasture).toMatchObject({ averageKgDmPerHa: 2000, totalKgDm: 80000, measuredHa: "40.00", noReading: 1, newestReading: "2026-09-01", daysSinceNewest: 51, fresh: false });
  });
  it("works the group's cover from every paddock's area and reading, not the average of the farms' averages", () => {
    // (34,500 + 80,000) ÷ 55.00 = 2,081.8 → 2,082; the average of 2,300 and 2,000 would be 2,150.
    expect(result.allFarms.pasture).toMatchObject({ averageKgDmPerHa: 2082, totalKgDm: 114500, measuredHa: "55.00", measuredPaddocks: 3, noReading: 2, oldestReading: "2026-09-01", newestReading: "2026-10-20", farmsWithReadings: 2, farmsNotFresh: 1 });
  });
  it("adds areas and fertiliser tonnes, and counts farms without a plan", () => {
    expect(result.allFarms).toMatchObject({ farms: 2, paddocks: 5, effectiveHa: "65.00", mappedHa: "65.20", plannedTonnes: "12.500", appliedTonnes: "4.000", farmsWithoutPlan: 1 });
  });
  it("keeps same-named paddocks on different farms apart", () => {
    expect(result.farms.map((farm) => farm.pasture.measuredPaddocks)).toEqual([2, 1]);
  });
  it("shows a farm with no readings as missing, not as zero cover", () => {
    const none = compareFarms("2026-10-22", [{ ...farms[1], paddocks: [{ paddockId: "22", name: "B", hectares: "2.00", latest: null }] }]);
    expect(none.farms[0].pasture).toMatchObject({ averageKgDmPerHa: null, newestReading: null, daysSinceNewest: null, fresh: false, noReading: 1 });
    expect(none.allFarms.pasture.averageKgDmPerHa).toBeNull();
  });
});
