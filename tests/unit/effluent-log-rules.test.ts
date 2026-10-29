import { describe, expect, it } from "vitest";
import { buffersBreached, COMPARISON_NOTE, flagTexts, hoursBetween, metresBetween, pondState, positionHours, summaryLines, workedOutDepth } from "@/lib/effluent/rules";
import { EMPTY_SETTINGS } from "@/lib/effluent/shared";

/** Effluent's sums and comparisons (#487, decisions 1080-1086). */
describe("effluent log rules", () => {
  it("works out depth for each kind of system, or says nothing when the settings don't give it", () => {
    expect(workedOutDepth("travelling_irrigator", { ...EMPTY_SETTINGS, flowM3PerHour: "18", wettedWidthM: "32", speedMPerHour: "60" }, {})).toEqual({ mm: "9.4", how: "18 m³ an hour ÷ (32 m wide × 60 m an hour)" });
    expect(workedOutDepth("travelling_irrigator", { ...EMPTY_SETTINGS, rateMmPerHour: "9" }, { hours: "3" })).toBeNull();
    expect(workedOutDepth("pods", { ...EMPTY_SETTINGS, rateMmPerHour: "4" }, { hours: "7.5" })?.mm).toBe("30");
    expect(workedOutDepth("fixed_sprinklers", { ...EMPTY_SETTINGS, rateMmPerHour: "4", pulsePercent: "50" }, { positionHours: ["7.5", "10", null] })?.mm).toBe("20");
    expect(workedOutDepth("pods", EMPTY_SETTINGS, { hours: "3" })).toBeNull();
    expect(workedOutDepth("slurry_tanker", { ...EMPTY_SETTINGS, tankM3: "11" }, { loads: 4, areaHa: "2.2" })?.mm).toBe("2");
    expect(workedOutDepth("slurry_tanker", { ...EMPTY_SETTINGS, tankM3: "11" }, { loads: 4, areaHa: null })).toBeNull();
  });

  it("times: hours between, and each position's time until the next move", () => {
    expect(hoursBetween("2026-10-29T08:00:00Z", "2026-10-29T15:30:00Z")).toBe("7.5");
    expect(hoursBetween("2026-10-29T08:00:00Z", "2026-10-29T07:00:00Z")).toBeNull();
    const positions = [{ label: "B", paddockId: null, point: null, movedAt: "2026-10-29T12:00:00Z" }, { label: "A", paddockId: null, point: null, movedAt: "2026-10-29T08:00:00Z" }];
    expect(positionHours(positions, "2026-10-29T13:00:00Z").map((each) => [each.position.label, each.hours])).toEqual([["A", "4"], ["B", "1"]]);
  });

  it("pond state: storage and days left on a straight-sided assumption, warnings and the gauge mark", () => {
    const pond = { capacityM3: "2800", fullAtMm: "2600", highAtMm: "2200", lowAtMm: "300", dailyInflowM3: "24", markers: [{ label: "Low", mm: "300" }, { label: "Medium", mm: "1300" }, { label: "Full", mm: "2600" }] };
    expect(pondState(pond, "1300")).toEqual({ percentFull: "50", storageLeftM3: "1400", daysLeft: "58.3", warning: null, mark: "Medium" });
    expect(pondState(pond, "2700")).toMatchObject({ storageLeftM3: "0", daysLeft: "0", warning: "high", mark: "Full" });
    expect(pondState(pond, "200")).toMatchObject({ warning: "low", mark: null });
    expect(pondState({ ...pond, fullAtMm: null }, "200")).toMatchObject({ percentFull: null, storageLeftM3: null, warning: "low" });
  });

  it("buffers: a point within a zone's buffer, from the consent when the zone has none", () => {
    expect(metresBetween([170.5, -45.9], [170.5, -45.8991])).toBeCloseTo(100, 0);
    const zones = [
      { recordId: "z1", data: { name: "Bore", feature: "bore" as const, point: [170.5, -45.9] as [number, number], zone: null, bufferM: null, removed: false } },
      { recordId: "z2", data: { name: "Creek", feature: "waterway" as const, point: null, zone: { type: "Polygon" as const, coordinates: [[[170.6, -45.9], [170.601, -45.9], [170.601, -45.901], [170.6, -45.901], [170.6, -45.9]]] as [number, number][][] }, bufferM: "20", removed: false } },
    ];
    const consent = { buffers: [{ feature: "bore" as const, metres: "100" }] };
    expect(buffersBreached([170.5, -45.8995], zones, consent).map((each) => [each.name, each.bufferM, each.metres])).toEqual([["Bore", 100, 56]]);
    expect(buffersBreached([170.5, -45.8995], zones, null)).toEqual([]);
    expect(buffersBreached([170.6005, -45.9005], zones, null).map((each) => each.metres)).toEqual([0]);
    expect(buffersBreached([170.6012, -45.9005], zones, null).map((each) => each.name)).toEqual(["Creek"]);
  });

  it("a position near a buffer is a phone estimate, not a finding (#491)", () => {
    const texts = flagTexts({ overDepth: false, overRate: false, tooSoon: [], ponding: null, inBuffer: [{ zoneId: "z", name: "Creek", bufferM: 20, metres: 12 }], usedWhileOutOfUse: false, noPondingCheck: false }, null);
    expect(texts[0]).toMatch(/phone's GPS.*not a finding that effluent reached it/);
  });

  it("the summary is counts against what was entered, never a verdict", () => {
    expect(COMPARISON_NOTE).toMatch(/don.t say whether the farm complies/);
    const summary = { applications: 4, overDepth: 0, overRate: 0, tooSoon: 1, ponding: 0, runoff: 0, inBuffer: 0, whileOutOfUse: 0, noPondingCheck: 0, noDepth: 1 };
    const lines = summaryLines(summary, { maxDepthMm: "25", maxRateMmPerHour: null, returnPeriodDays: 14 } as never);
    expect(lines).toContain("Applications over the most depth entered (25 mm): 0");
    expect(lines).toContain("Most rate: not entered for the consent, so not compared");
    for (const text of lines) expect(text).not.toMatch(/\bcompli(es|ant)\b|\bpass(ed)?\b|\bbreach/i);
  });
});
