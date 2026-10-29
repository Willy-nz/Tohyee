import { describe, expect, it } from "vitest";
import { calibrationPairs, calibrationSummary, calibrationText, type CalibrationReading, isEstimate, parseCalibrationWindow } from "@/lib/farming/pasture-rules";
import { takenOnFor } from "@/lib/farming/pasture-photos";

/** Photo estimates beside other readings (#503, decision 1166). Made-up figures. */
describe("photo estimate calibration", () => {
  const reading = (id: string, paddockId: string, measuredOn: string, cover: number, method: CalibrationReading["method"] = "plate_meter"): CalibrationReading => ({ id, paddockId, measuredOn, cover, method });

  it("pairs an estimate with the nearest reading of the same paddock inside the window, never a photo reading", () => {
    const pairs = calibrationPairs(
      [{ id: "e1", paddockId: "7", takenOn: "2026-10-10", cover: 2300 }],
      [
        reading("1", "7", "2026-10-07", 2600), // 3 days: outside 2
        reading("2", "7", "2026-10-12", 2500), // 2 days after
        reading("3", "7", "2026-10-09", 2450), // 1 day before: nearest
        reading("4", "8", "2026-10-10", 9999), // another paddock
        reading("5", "7", "2026-10-10", 2400, "photo_ai"), // a photo's own accepted estimate
      ],
      2,
    );
    expect(pairs.get("plate_meter")).toEqual([{ estimateId: "e1", readingId: "3", paddockId: "7", takenOn: "2026-10-10", measuredOn: "2026-10-09", estimate: 2300, reading: 2450, difference: -150 }]);
    expect(pairs.has("photo_ai")).toBe(false);
  });

  it("breaks ties: on or before the photo first, then the latest recorded", () => {
    const before = calibrationPairs([{ id: "e", paddockId: "7", takenOn: "2026-10-10", cover: 2000 }], [reading("10", "7", "2026-10-11", 2100), reading("11", "7", "2026-10-09", 2200)], 1);
    expect(before.get("plate_meter")![0].readingId).toBe("11");
    const latest = calibrationPairs([{ id: "e", paddockId: "7", takenOn: "2026-10-10", cover: 2000 }], [reading("12", "7", "2026-10-10", 2100), reading("13", "7", "2026-10-10", 2200)], 0);
    expect(latest.get("plate_meter")![0].readingId).toBe("13");
  });

  it("keeps each method on its own and leaves out everything outside a same-day window", () => {
    const estimates = [{ id: "e", paddockId: "7", takenOn: "2026-10-10", cover: 2000 }];
    const readings = [reading("1", "7", "2026-10-10", 2200), reading("2", "7", "2026-10-10", 1900, "satellite"), reading("3", "7", "2026-10-11", 2500)];
    const groups = calibrationSummary(estimates, readings, 0);
    expect(groups.map((group) => [group.method, group.count, group.averageDifference])).toEqual([
      ["plate_meter", 1, -200],
      ["satellite", 1, 100],
    ]);
  });

  it("averages the differences and their size, half up to the kg, with the range", () => {
    const estimates = [
      { id: "a", paddockId: "1", takenOn: "2026-09-01", cover: 2000 }, // -400
      { id: "b", paddockId: "2", takenOn: "2026-09-01", cover: 2100 }, // -101
      { id: "c", paddockId: "3", takenOn: "2026-09-02", cover: 2650 }, // +150
    ];
    const readings = [reading("1", "1", "2026-09-02", 2400), reading("2", "2", "2026-09-01", 2201), reading("3", "3", "2026-09-04", 2500)];
    const [group] = calibrationSummary(estimates, readings, 2);
    // (-400 - 101 + 150) / 3 = -117; (400 + 101 + 150) / 3 = 217
    expect(group).toMatchObject({ method: "plate_meter", count: 3, averageDifference: -117, averageGap: 217, lowest: -400, highest: 150 });
    expect(group.pairs.map((pair) => pair.estimateId)).toEqual(["c", "a", "b"]);
    expect(calibrationText(group, 2)).toBe(
      "Photo estimates were 117 kg DM/ha lower than plate meter readings on average, over 3 checks within 2 days. The differences ran from 400 kg DM/ha lower to 150 kg DM/ha higher; an estimate was 217 kg DM/ha away on average.",
    );
  });

  it("says one check, and a satellite comparison, in plain words", () => {
    const [group] = calibrationSummary([{ id: "e", paddockId: "1", takenOn: "2026-09-01", cover: 2180 }], [reading("1", "1", "2026-09-01", 2000, "satellite")], 0);
    expect(calibrationText(group, 0)).toBe("Photo estimates were 180 kg DM/ha higher than satellite readings on average, over 1 check within the same day.");
    expect(calibrationSummary([], [reading("1", "1", "2026-09-01", 2000)], 2)).toEqual([]);
  });

  it("reads the window: 0-14 whole days, 2 by default", () => {
    expect(parseCalibrationWindow(undefined)).toBe(2);
    expect(parseCalibrationWindow("7")).toBe(7);
    expect(parseCalibrationWindow("15")).toBeNull();
    expect(parseCalibrationWindow("1.5")).toBeNull();
    expect(parseCalibrationWindow("-1")).toBeNull();
  });

  it("labels a reading from a photo as an estimate", () => {
    expect(isEstimate("photo_ai")).toBe(true);
    expect(isEstimate("plate_meter")).toBe(false);
  });

  it("dates a photo by the phone's clock in New Zealand, unless that's in the future or over a year back", () => {
    const now = new Date("2026-10-30T02:00:00Z");
    expect(takenOnFor("2026-10-29T20:00:00Z", now)).toBe("2026-10-30"); // 9 am NZDT
    expect(takenOnFor("2026-10-31T02:00:00Z", now)).toBe("2026-10-30");
    expect(takenOnFor("2024-01-01T00:00:00Z", now)).toBe("2026-10-30");
    expect(takenOnFor(null, now)).toBe("2026-10-30");
  });
});
