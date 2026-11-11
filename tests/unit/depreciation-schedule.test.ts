import { describe, expect, it } from "vitest";
import type { FixedAssetRegister } from "@/lib/fixed-assets/register";
import { depreciationSchedule } from "@/lib/fixed-assets/schedule";

/** FS12 (not yet reviewed): the depreciation schedule from the register. Made-up assets. */
describe("depreciation schedule", () => {
  const register: FixedAssetRegister = {
    asOf: "2027-03-31",
    financialYearStart: "2026-04-01",
    groups: [
      {
        typeId: "1",
        typeName: "Computers",
        assets: [
          { id: "a1", assetNumber: "FA-1", name: "Computer", purchaseDate: "2025-04-01", method: "dv", rate: "50", cost: "2000.00", accumulatedDepreciation: "1500.00", bookValue: "500.00", depreciationThisYear: "500.00" },
        ],
        totals: { cost: "2000.00", accumulatedDepreciation: "1500.00", bookValue: "500.00", depreciationThisYear: "500.00" },
      },
      {
        typeId: "2",
        typeName: "Furniture",
        assets: [
          { id: "a2", assetNumber: "FA-2", name: "Chair", purchaseDate: "2026-07-01", method: "sl", rate: "10", cost: "600.00", accumulatedDepreciation: "45.00", bookValue: "555.00", depreciationThisYear: "45.00" },
        ],
        totals: { cost: "600.00", accumulatedDepreciation: "45.00", bookValue: "555.00", depreciationThisYear: "45.00" },
      },
    ],
    totals: { cost: "2600.00", accumulatedDepreciation: "1545.00", bookValue: "1055.00", depreciationThisYear: "545.00" },
    disposals: [
      {
        id: "a3",
        assetNumber: "FA-3",
        name: "Desk",
        typeName: "Furniture",
        purchaseDate: "2024-04-01",
        disposalDate: "2026-09-30",
        cost: "500.00",
        accumulatedDepreciation: "220.00",
        proceeds: "100.00",
        gainOrLoss: "-180.00",
        depreciationThisYear: "20.00",
      },
    ],
    ledger: [],
    ties: true,
  };

  it("FS12: opening, additions, disposals, depreciation and closing for each asset, type and in all", () => {
    const schedule = depreciationSchedule(register)!;
    const row = (entry: { cost: string; opening: string; additions: string; disposals: string; depreciation: string; closing: string }) => [
      entry.cost,
      entry.opening,
      entry.additions,
      entry.disposals,
      entry.depreciation,
      entry.closing,
    ];
    expect(schedule.groups.map((group) => group.typeName)).toEqual(["Computers", "Furniture"]);
    expect(schedule.groups[0].assets.map((asset) => [asset.name, asset.rate, ...row(asset)])).toEqual([["Computer", "DV 50%", "2000.00", "1000.00", "0.00", "0.00", "500.00", "500.00"]]);
    expect(schedule.groups[1].assets.map((asset) => [asset.name, asset.rate, asset.disposedOn, ...row(asset)])).toEqual([
      ["Chair", "SL 10%", null, "600.00", "0.00", "600.00", "0.00", "45.00", "555.00"],
      ["Desk", "", "2026-09-30", "500.00", "300.00", "0.00", "280.00", "20.00", "0.00"],
    ]);
    expect(row(schedule.groups[1].totals)).toEqual(["1100.00", "300.00", "600.00", "280.00", "65.00", "555.00"]);
    expect(row(schedule.totals)).toEqual(["3100.00", "1300.00", "600.00", "280.00", "565.00", "1055.00"]);
  });

  it("FS12: no assets in the year, no schedule", () => {
    expect(depreciationSchedule({ ...register, groups: [], disposals: [] })).toBeNull();
  });
});
