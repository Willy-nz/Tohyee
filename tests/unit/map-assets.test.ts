import { describe, expect, it } from "vitest";
import { areaText, distanceMetres, distanceText, drawnHectares, isLineKind, lengthMetres, overlayLayer } from "@/lib/farming/map-assets-rules";

/** Map assets and measuring (MA4-MA6; decisions 1462-1465, not yet reviewed). */
describe("map assets and measuring", () => {
  it("MA4 distances are geodesic: m under a kilometre, then km to two places", () => {
    // 0.01° of latitude at 46° S is about 1,112 m.
    expect(Math.round(distanceMetres([169.8, -46.18], [169.8, -46.19]))).toBe(1112);
    // Two legs added: 0.001° east at 46° S is about 77 m.
    const legs = lengthMetres([[169.8, -46.18], [169.801, -46.18], [169.801, -46.181]]);
    expect(Math.round(legs)).toBe(188); // 77 + 111
    expect(distanceText(640.4)).toBe("640 m");
    expect(distanceText(999.4)).toBe("999 m");
    expect(distanceText(1249)).toBe("1.25 km");
    expect(distanceText(12_345)).toBe("12.35 km");
    expect(lengthMetres([[169.8, -46.18]])).toBe(0);
  });

  it("MA5 a drawn area is closed for you: m² under a hectare, then ha", () => {
    // About 77 m × 111 m: 0.86 ha.
    const corners: Array<[number, number]> = [[169.8, -46.18], [169.801, -46.18], [169.801, -46.181], [169.8, -46.181]];
    const hectares = drawnHectares(corners);
    expect(hectares).toBeGreaterThan(0.85);
    expect(hectares).toBeLessThan(0.87);
    expect(areaText(hectares)).toMatch(/^8,\d{3} m² \(0\.86 ha\)$/);
    expect(areaText(12.344)).toBe("12.34 ha");
    expect(areaText(1234.5)).toBe("1,234.50 ha");
    expect(drawnHectares(corners.slice(0, 2))).toBe(0);
  });

  it("MA6 layers: assets, gauges and tasks by id, effluent by tone, hazards otherwise", () => {
    expect(overlayLayer({ id: "asset-3", tone: "asset" })).toBe("assets");
    expect(overlayLayer({ id: "gauge-1", tone: "effluent" })).toBe("rain");
    expect(overlayLayer({ id: "task-9", tone: "warning" })).toBe("tasks");
    expect(overlayLayer({ id: "m12", tone: "effluent" })).toBe("effluent");
    expect(overlayLayer({ id: "57", tone: "danger" })).toBe("hazards");
    expect(overlayLayer({ id: "58", tone: "warning" })).toBe("hazards");
    expect([isLineKind("fence"), isLineKind("trough")]).toEqual([true, false]);
  });
});
