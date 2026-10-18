import { describe, expect, it } from "vitest";
import { farmCover, grazingEaten, growthBetween, parseCover, type Reading, supplementTotals } from "@/lib/farming/pasture-rules";

const reading = (measuredOn: string, cover: number, method: Reading["method"] = "plate_meter", id = measuredOn): Reading => ({ id, paddockId: "1", measuredOn, cover, method });

describe("pasture and feed (PF1-PF6, not yet reviewed)", () => {
  it("PF1 covers are whole kg DM/ha from 0 to 20,000", () => {
    expect([parseCover("2,450"), parseCover("0"), parseCover("20000"), parseCover("20001"), parseCover("2450.5"), parseCover("-1"), parseCover("")]).toEqual([2450, 0, 20000, null, null, null, null]);
  });

  it("PF2 growth between readings by the same method, with no grazing in between", () => {
    expect(growthBetween(reading("2026-09-01", 2100), reading("2026-09-15", 2450), [])).toEqual({ kind: "rate", from: "2026-09-01", to: "2026-09-15", kgDmPerHaPerDay: "25.0" });
    expect(growthBetween(reading("2026-09-01", 2100), reading("2026-09-15", 2030), [])).toMatchObject({ kind: "rate", kgDmPerHaPerDay: "-5.0" });
    expect(growthBetween(reading("2026-09-01", 2100), reading("2026-09-15", 2450, "satellite"), [])).toMatchObject({ kind: "none", reason: "different_methods" });
    expect(growthBetween(reading("2026-09-01", 2100), reading("2026-09-15", 2450), [{ paddockId: "1", inOn: "2026-09-05", outOn: "2026-09-06" }])).toMatchObject({ kind: "none", reason: "grazed" });
    // A pre-grazing reading on the day in, or a post-grazing one on the day out, isn't "grazed in between".
    expect(growthBetween(reading("2026-09-06", 1600), reading("2026-09-20", 2020), [{ paddockId: "1", inOn: "2026-09-05", outOn: "2026-09-06" }])).toMatchObject({ kind: "rate", kgDmPerHaPerDay: "30.0" });
    expect(growthBetween(reading("2026-09-01", 2100), reading("2026-09-01", 2200, "plate_meter", "b"), [])).toMatchObject({ kind: "none", reason: "same_day" });
  });

  it("PF3, PF4 farm cover from each paddock's latest reading, and the feed wedge", () => {
    const cover = farmCover("2026-09-20", [
      { paddockId: "1", name: "A", hectares: "10.00", latest: { ...reading("2026-09-18", 2500), paddockId: "1" } },
      { paddockId: "2", name: "B", hectares: "5.00", latest: { ...reading("2026-09-10", 1900, "satellite"), paddockId: "2" } },
      { paddockId: "3", name: "C", hectares: "8.00", latest: null },
      { paddockId: "4", name: "D", hectares: null, latest: { ...reading("2026-09-18", 3000), paddockId: "4" } },
    ]);
    expect(cover).toMatchObject({ averageKgDmPerHa: 2300, totalKgDm: 34500, hectares: "15.00", oldestReading: "2026-09-10", estimates: 1, readings: 2, noReading: ["C"], noArea: ["D"] });
    expect(cover.wedge.map((entry) => [entry.name, entry.cover, entry.estimate])).toEqual([["A", 2500, false], ["B", 1900, true]]);
    expect(farmCover("2026-09-20", []).averageKgDmPerHa).toBeNull();
  });

  it("PF5 what a grazing ate", () => {
    expect(grazingEaten({ preCover: 2800, postCover: 1600, hectares: "10.00", head: 220 })).toEqual({ perHa: 1200, totalKgDm: 12000, perHead: "54.5" });
    expect(grazingEaten({ preCover: 2800, postCover: null, hectares: "10.00", head: 220 })).toBeNull();
    expect(grazingEaten({ preCover: 2800, postCover: 1600, hectares: null, head: null })).toEqual({ perHa: 1200, totalKgDm: null, perHead: null });
  });

  it("PF6 kg DM fed counts kg DM quantities and typed kg DM only", () => {
    const totals = supplementTotals([
      { fedOn: "2026-08-01", feed: "Baleage", quantity: "20", unit: "bales", kgDm: "4000" },
      { fedOn: "2026-08-02", feed: "PKE", quantity: "2000", unit: "kg_dm", kgDm: null },
      { fedOn: "2026-08-03", feed: "Hay", quantity: "10", unit: "bales", kgDm: null },
    ]);
    expect(totals.kgDm).toBe("6000.00");
    expect(totals.notCounted.map((line) => line.feed)).toEqual(["Hay"]);
  });
});
