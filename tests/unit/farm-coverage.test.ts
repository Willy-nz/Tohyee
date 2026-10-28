import { describe, expect, it } from "vitest";
import { computeCoverage, gpsQuality, localProjection, THRESHOLDS, type Track, type TrackPoint, type TrackSettings } from "@/lib/farming/coverage";
import { areaHectares, type PaddockGeometry, type Position } from "@/lib/farming/geometry";

/*
 * Tractor coverage (#472 stage 5, decisions 1020-1024): known routes on a
 * made-up farm, drawn in metres and turned into longitude and latitude.
 */

const ORIGIN: Position = [170.2, -45.9];
const grid = localProjection(ORIGIN);
const at = (x: number, y: number) => grid.toLonLat([x, y]);
const START = Date.UTC(2026, 9, 28, 9, 0, 0);

type Step = { x: number; y: number; w?: boolean; s?: number; acc?: number | null; b?: boolean; dt?: number; spd?: number };

/** Fixes one second apart (or `dt` seconds after the last), accuracy 4 m unless given. */
function points(steps: Step[]): TrackPoint[] {
  let t = START;
  return steps.map((step, index) => {
    if (index > 0) t += (step.dt ?? 1) * 1000;
    const [lon, lat] = at(step.x, step.y);
    const point: TrackPoint = { t, lon, lat, acc: step.acc === undefined ? 4 : step.acc, w: step.w ?? true, s: step.s ?? 0 };
    if (step.b) point.b = true;
    if (step.spd !== undefined) point.spd = step.spd;
    return point;
  });
}

/** A straight line east from (x0, y) to (x1, y), a fix every 2 m (2 m/s). */
function line(x0: number, x1: number, y: number, extra: Partial<Step> = {}): Step[] {
  const steps: Step[] = [];
  const dir = x1 >= x0 ? 1 : -1;
  for (let x = x0; dir > 0 ? x <= x1 : x >= x1; x += 2 * dir) steps.push({ x, y, ...extra });
  return steps;
}

const WIDTH_10: TrackSettings = { widthM: 10, lateralM: 0, backM: 0 };

function square(x0: number, y0: number, x1: number, y1: number): PaddockGeometry {
  return { type: "Polygon", coordinates: [[at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)]] };
}

describe("tractor coverage", () => {
  it("a straight 100 m run at 10 m wide is 0.1 ha", () => {
    const result = computeCoverage({ settings: [WIDTH_10], points: points(line(0, 100, 0)) });
    expect(result.summary.workedHa).toBeCloseTo(0.1, 3);
    expect(result.summary.grossHa).toBeCloseTo(0.1, 3);
    expect(result.summary.overlapHa).toBeCloseTo(0, 4);
    expect(result.summary.distanceM).toBeCloseTo(100, 0);
    expect(result.summary.coveredPct).toBeNull();
    expect(result.gaps).toEqual([]);
  });

  it("Working OFF doesn't add area: 100 m on, 50 m off, 100 m on is 0.2 ha", () => {
    const steps = [...line(0, 100, 0), ...line(102, 150, 0, { w: false }), ...line(152, 252, 0)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.summary.workedHa).toBeCloseTo(0.2, 3);
    expect(result.summary.workingDistanceM).toBeCloseTo(200, 0);
    expect(result.summary.distanceM).toBeCloseTo(252, 0);
  });

  it("going over the same strip twice counts once, and the second time is overlap", () => {
    // East with Working ON, a turn with it OFF, back west along the same line ON.
    const steps = [...line(0, 100, 0), ...line(102, 110, 0, { w: false }), { x: 110, y: 4, w: false }, { x: 106, y: 4, w: false }, ...line(100, 0, 0)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.summary.workedHa).toBeCloseTo(0.1, 3);
    expect(result.summary.overlapHa).toBeCloseTo(0.1, 3);
    expect(result.summary.grossHa).toBeCloseTo(0.2, 3);
  });

  it("side-by-side passes add up, with only the turn overlapping", () => {
    // Out along y = 0, a U-turn with Working ON, back along y = 10 (exactly one width over).
    const turn: Step[] = [];
    for (let angle = 10; angle < 180; angle += 10) {
      const rad = (angle * Math.PI) / 180;
      turn.push({ x: 100 + 5 * Math.sin(rad), y: 5 - 5 * Math.cos(rad) });
    }
    const steps = [...line(0, 100, 0), ...turn, ...line(100, 0, 10)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    // Two strips of 0.1 ha plus the turn: the implement sweeps a half-disc 10 m across (157 m²), so about 0.2157 ha.
    expect(result.summary.workedHa).toBeGreaterThan(0.199);
    expect(result.summary.workedHa).toBeLessThan(0.218);
    // The turn's inside is gone over twice, but it's small next to the strips.
    expect(result.summary.overlapHa).toBeLessThan(0.01);
    expect(result.summary.grossHa).toBeGreaterThanOrEqual(result.summary.workedHa);
  });

  it("a width change mid-job uses each stretch's own width", () => {
    const steps = [...line(0, 100, 0, { s: 0 }), ...line(102, 202, 0, { s: 1 })];
    const result = computeCoverage({ settings: [WIDTH_10, { widthM: 20, lateralM: 0, backM: 0 }], points: points(steps) });
    // 100 m × 10 m + 100 m × 20 m; the 2 m where the width changed isn't counted.
    expect(result.summary.workedHa).toBeCloseTo(0.3, 3);
  });

  it("clips to the paddock: worked inside, outside and missed are separate", () => {
    // A 50 m square paddock from x 25 to 75, y -25 to 25; the run crosses it.
    const paddock = square(25, -25, 75, 25);
    const result = computeCoverage({ settings: [WIDTH_10], points: points(line(0, 100, 0)) }, [paddock]);
    expect(result.summary.paddockHa).toBeCloseTo(0.25, 3);
    expect(result.summary.workedHa).toBeCloseTo(0.05, 3);
    expect(result.summary.outsideHa).toBeCloseTo(0.05, 3);
    expect(result.summary.missedHa).toBeCloseTo(0.2, 3);
    expect(result.summary.sweptHa).toBeCloseTo(0.1, 3);
    expect(result.summary.coveredPct).toBeCloseTo(20, 0);
    expect(result.missed?.coordinates.length).toBeGreaterThan(0);
  });

  it("a GPS spike is dropped, not painted", () => {
    const steps = line(0, 100, 0);
    steps.splice(25, 0, { x: 50, y: 200 }); // 200 m off the line for one fix
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.summary.points.jumps).toBe(1);
    expect(result.summary.workedHa).toBeCloseTo(0.1, 3);
  });

  it("a GPS jump that stays starts again over there, with a gap and no strip between", () => {
    const steps = [...line(0, 50, 0), ...line(300, 350, 0)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toBe("jump");
    expect(result.summary.workedHa).toBeCloseTo(0.1, 3);
    expect(result.lines).toHaveLength(2);
  });

  it("no fixes for longer than the limit leaves a gap, never a straight line", () => {
    // 40 m driven with no fixes for 20 seconds.
    const steps = [...line(0, 50, 0), { ...line(90, 90, 0)[0], dt: 20 }, ...line(92, 140, 0)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toBe("no_fix");
    expect(result.gaps[0].seconds).toBe(20);
    expect(result.summary.workedHa).toBeCloseTo(0.1, 3);
    expect(result.summary.gapSeconds).toBe(20);
  });

  it("fixes vaguer than the limit break the track", () => {
    const steps = line(0, 100, 0).map((step) => (step.x > 40 && step.x < 60 ? { ...step, acc: 35 } : step));
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.summary.points.poorAccuracy).toBe(9);
    expect(result.gaps[0].reason).toBe("poor_accuracy");
    // 0-40 and 60-100: the 20 m in between isn't painted.
    expect(result.summary.workedHa).toBeCloseTo(0.08, 3);
    expect(gpsQuality(4)).toBe("good");
    expect(gpsQuality(15)).toBe("weak");
    expect(gpsQuality(35)).toBe("poor");
    expect(gpsQuality(null)).toBe("none");
  });

  it("a pause breaks the track even if the position carries on", () => {
    const steps = [...line(0, 50, 0), { x: 70, y: 0, b: true, dt: 5 }, ...line(72, 120, 0)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.gaps[0].reason).toBe("paused");
    // 0-50 and 70-120: nothing from 50 to 70.
    expect(result.summary.workedHa).toBeCloseTo(0.1, 3);
  });

  it("standing still with the GPS wandering paints nothing and adds no distance", () => {
    const wander: Step[] = [];
    for (let i = 0; i < 60; i += 1) wander.push({ x: 100 + Math.sin(i * 1.7), y: Math.cos(i * 2.3) });
    const steps = [...line(0, 100, 0), ...wander, ...line(102, 200, 0)];
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.summary.workedHa).toBeLessThan(0.2 + 0.003);
    expect(result.summary.workedHa).toBeGreaterThan(0.19);
    expect(result.summary.distanceM).toBeLessThan(205);
    expect(result.summary.points.stationary).toBeGreaterThan(30);
  });

  it("the device's own speed decides standing still when it gives one", () => {
    const steps = line(0, 20, 0).map((step) => ({ ...step, spd: 0 }));
    const result = computeCoverage({ settings: [WIDTH_10], points: points(steps) });
    expect(result.summary.workedHa).toBe(0);
  });

  it("moves the strip by the implement's offset", () => {
    const offset = computeCoverage({ settings: [{ widthM: 10, lateralM: 5, backM: 0 }], points: points(line(0, 100, 0)) }, [square(-10, -20, 110, 0)]);
    // Driving east, 5 m to the right is south: the whole strip is in the paddock below the line.
    expect(offset.summary.workedHa).toBeCloseTo(0.1, 3);
    expect(offset.summary.outsideHa).toBeCloseTo(0, 3);
    const centred = computeCoverage({ settings: [WIDTH_10], points: points(line(0, 100, 0)) }, [square(-10, -20, 110, 0)]);
    expect(centred.summary.workedHa).toBeCloseTo(0.05, 3);
  });

  it("is deterministic: the same fixes in any order give the same answer", () => {
    const steps = [...line(0, 100, 0), ...line(102, 110, 0, { w: false }), ...line(100, 0, 6)];
    const track: Track = { settings: [WIDTH_10], points: points(steps) };
    const first = computeCoverage(track, [square(10, -10, 90, 10)]);
    const shuffled = computeCoverage({ ...track, points: [...track.points].reverse() }, [square(10, -10, 90, 10)]);
    expect(shuffled).toEqual(first);
  });

  it("nothing recorded gives zero and empty shapes", () => {
    const result = computeCoverage({ settings: [WIDTH_10], points: [] });
    expect(result.summary.workedHa).toBe(0);
    expect(result.footprint.coordinates).toEqual([]);
  });

  it("the local grid's areas agree with geodesic areas to 0.1%", () => {
    const paddock = square(-400, -300, 400, 300);
    const result = computeCoverage({ settings: [WIDTH_10], points: points(line(0, 10, 0)) }, [paddock]);
    expect(Math.abs(result.summary.paddockHa! - areaHectares(paddock)) / areaHectares(paddock)).toBeLessThan(0.001);
  });

  it("documents its limits", () => {
    expect(THRESHOLDS).toEqual({ goodAccuracyM: 10, maxAccuracyM: 20, maxGapS: 10, maxSpeedMs: 12, minStepM: 2, minSpeedMs: 0.5, stillWindowS: 5, simplifyM: 0.5, turnDeg: 60 });
  });
});

describe("tractor coverage on a full job", () => {
  it("an hour of back-and-forth passes works out in a few seconds and adds up", () => {
    // 24 m spreading width, passes 22 m apart (2 m overlap each), 400 m long, 2.5 m/s, turns with Working OFF.
    const steps: Step[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const y = pass * 22;
      const east = pass % 2 === 0;
      for (let i = 0; i <= 160; i += 1) steps.push({ x: east ? i * 2.5 : 400 - i * 2.5, y: y + 0.4 * Math.sin(i / 7) });
      steps.push({ x: east ? 405 : -5, y: y + 11, w: false, dt: 4 });
      steps.push({ x: east ? 400 : 0, y: y + 22, w: false, dt: 4 });
    }
    const started = performance.now();
    const result = computeCoverage({ settings: [{ widthM: 24, lateralM: 0, backM: 0 }], points: points(steps) }, [square(0, -12, 400, 430)]);
    const seconds = (performance.now() - started) / 1000;
    expect(seconds).toBeLessThan(10);
    // 400 m × (19 × 22 m + 24 m) = 0.4 × 442 m ≈ 17.68 ha swept; the paddock is 400 × 442 = 17.68 ha.
    expect(result.summary.sweptHa).toBeGreaterThan(17.4);
    expect(result.summary.sweptHa).toBeLessThan(17.9);
    // 19 overlaps of 2 m × 400 m = 1.52 ha.
    expect(result.summary.overlapHa).toBeGreaterThan(1.3);
    expect(result.summary.overlapHa).toBeLessThan(1.75);
    expect(result.summary.coveredPct).toBeGreaterThan(97);
  });
});
