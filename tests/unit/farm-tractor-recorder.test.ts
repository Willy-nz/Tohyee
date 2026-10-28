import { describe, expect, it } from "vitest";
import { computeCoverage, localProjection, type TrackPoint } from "@/lib/farming/coverage";
import { finish, onFix, onPermissionDenied, onTick, onVisibility, pause, reopenRecorder, resume, setSettings, setWorking, startRecorder, statusBanner, type Step } from "@/lib/farming/tractor-recorder";
import { jobGeoJson, jobGpx, packPoint, trackPieces, type JobTrack, type TrackEvent } from "@/lib/farming/tractor-shared";

/* Tractor mode's recorder (#472 stage 5, decisions 1021-1023), driven without a browser. */

const grid = localProjection([170.2, -45.9]);
const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);

function drive() {
  let step: Step = startRecorder(T0);
  const points: TrackPoint[] = [];
  const events: TrackEvent[] = [...step.events];
  const apply = (next: Step) => {
    step = next;
    points.push(...next.points);
    events.push(...next.events);
  };
  let x = 0;
  let t = T0;
  const fix = (acc = 4) => {
    t += 1000;
    x += 2;
    const [lon, lat] = grid.toLonLat([x, 0]);
    apply(onFix(step.state, { t, lon, lat, acc }, t));
  };
  return { fix, apply, state: () => step.state, points, events, now: () => t, wait: (seconds: number) => (t += seconds * 1000), move: (metres: number) => (x += metres) };
}

describe("tractor recorder", () => {
  it("records Working ON and OFF on each fix, and a point straight away when switched", () => {
    const run = drive();
    run.fix();
    run.apply(setWorking(run.state(), true, run.now() + 200));
    expect(run.points.at(-1)).toMatchObject({ w: true });
    for (let i = 0; i < 5; i += 1) run.fix();
    run.apply(setWorking(run.state(), false, run.now() + 100));
    run.fix();
    expect(run.points.map((point) => point.w)).toEqual([false, true, true, true, true, true, true, false, false]);
    expect(run.events.map((event) => event.kind)).toEqual(["start", "working_on", "working_off"]);
  });

  it("switching between fixes doesn't look like a GPS jump", () => {
    const run = drive();
    run.fix();
    run.fix();
    // Tapped 900 ms after the last fix; the next fix comes 100 ms later.
    run.apply(setWorking(run.state(), true, run.now() + 900));
    for (let i = 0; i < 10; i += 1) run.fix();
    const coverage = computeCoverage({ settings: [{ widthM: 10, lateralM: 0, backM: 0 }], points: run.points });
    expect(coverage.summary.points.jumps).toBe(0);
    // Ten 2 m stretches with Working ON, 10 m wide.
    expect(coverage.summary.workedHa).toBeCloseTo(0.02, 3);
  });

  it("pausing turns Working OFF and records nothing; resuming starts a new piece", () => {
    const run = drive();
    run.apply(setWorking(run.state(), true, run.now()));
    run.fix();
    run.fix();
    run.apply(pause(run.state(), run.now()));
    const before = run.points.length;
    run.fix();
    run.fix();
    expect(run.points.length).toBe(before);
    run.apply(resume(run.state(), run.now()));
    run.fix();
    expect(run.points.at(-1)).toMatchObject({ b: true, w: false });
    expect(run.events.map((event) => event.kind)).toEqual(["start", "working_on", "working_off", "pause", "resume"]);
  });

  it("the screen going off stops recording, says so, and leaves a gap", () => {
    const run = drive();
    run.apply(setWorking(run.state(), true, run.now()));
    for (let i = 0; i < 10; i += 1) run.fix();
    run.apply(onVisibility(run.state(), false, run.now()));
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "on" }).title).toMatch(/NOT RECORDING: screen off/);
    run.fix(); // a fix delivered while hidden is dropped
    run.move(100);
    run.wait(60);
    run.apply(onVisibility(run.state(), true, run.now()));
    for (let i = 0; i < 10; i += 1) run.fix();
    expect(run.points.filter((point) => point.b)).toHaveLength(1);
    const coverage = computeCoverage({ settings: [{ widthM: 10, lateralM: 0, backM: 0 }], points: run.points });
    expect(coverage.gaps).toHaveLength(1);
    // Two runs of about 18 m each, nothing across the 100 m gap.
    expect(coverage.summary.workedHa).toBeLessThan(0.05);
  });

  it("no fix for over 10 seconds is GPS lost; a fix brings it back with a gap", () => {
    const run = drive();
    run.fix();
    run.wait(11);
    run.apply(onTick(run.state(), run.now()));
    expect(run.state().interruption).toBe("gps_lost");
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "on" }).title).toBe("NOT RECORDING: no GPS");
    run.fix();
    expect(run.state().interruption).toBeNull();
    expect(run.points.at(-1)?.b).toBe(true);
    expect(run.events.map((event) => event.kind)).toEqual(["start", "gps_lost", "gps_back"]);
  });

  it("removed permission and weak GPS are shown plainly", () => {
    const run = drive();
    run.fix(35);
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "on" })).toMatchObject({ tone: "danger", title: "GPS weak (±35 m): not counting" });
    run.fix(14);
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "on" }).tone).toBe("warning");
    run.fix(4);
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "on" }).tone).toBe("ok");
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "unsupported" }).detail).toMatch(/keep it on/);
    run.apply(onPermissionDenied(run.state(), run.now()));
    expect(statusBanner(run.state(), { now: run.now(), wakeLock: "on" }).title).toMatch(/location is off/);
  });

  it("a width change applies from then on", () => {
    const run = drive();
    run.fix();
    run.apply(setSettings(run.state(), 1, run.now()));
    run.fix();
    expect(run.points.map((point) => point.s)).toEqual([0, 1]);
  });

  it("reopening after the app closed mid-job comes back paused, with a gap", () => {
    const run = drive();
    run.apply(setWorking(run.state(), true, run.now()));
    run.fix();
    const reopened = reopenRecorder(run.state(), run.now() + 60_000);
    expect(reopened.state).toMatchObject({ status: "paused", working: false, breakNext: true });
    expect(reopened.events[0].kind).toBe("reopened");
    expect(finish(reopened.state, run.now()).state.status).toBe("finished");
  });
});

describe("tractor exports", () => {
  const points: TrackPoint[] = [0, 1, 2, 3, 4, 5].map((i) => {
    const [lon, lat] = grid.toLonLat([i * 2, 0]);
    return { t: T0 + i * 1000, lon, lat, acc: 4, w: i >= 2, s: 0, ...(i === 4 ? { b: true } : {}) };
  });
  const track: JobTrack = { version: 1, settings: [{ widthM: 10, lateralM: 0, backM: 0, settingsId: null }], points: points.map(packPoint), events: [] };

  it("splits the raw track at breaks and where Working changed", () => {
    expect(trackPieces(track).map((piece) => [piece.working, piece.points.length])).toEqual([
      [false, 2],
      [true, 3],
      [true, 2],
    ]);
  });

  it("GPX has one segment per unbroken piece and the notice", () => {
    const gpx = jobGpx({ id: "x", operation: "spraying", startedAt: "2026-10-28T09:00:00Z", paddockNames: [], track });
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2);
    expect(gpx).toContain("Unassigned paddock");
    expect(gpx).toContain("<type>working</type>");
    expect(gpx).toContain("Estimated from phone GPS");
  });

  it("GeoJSON marks estimates as not measured and declared values as entered", () => {
    const coverage = computeCoverage({ settings: [{ widthM: 10, lateralM: 0, backM: 0 }], points });
    const { summary, ...rest } = coverage;
    const geo = jobGeoJson({ id: "x", operation: "spreading", startedAt: "", finishedAt: "", operatorEmail: "a@example.com", equipmentName: null, paddockNames: [], summary, track, coverage: rest, product: "Urea", declaredRate: "100", declaredRateUnit: "kg/ha", declaredQuantity: null, declaredQuantityUnit: null });
    expect(geo.tohyee.declared).toEqual({ product: "Urea", rate: "100 kg/ha", quantity: null, note: "Entered by a person, not measured." });
    const worked = (geo.features as Array<{ properties: { layer: string; measured?: boolean } }>).find((feature) => feature.properties.layer === "worked");
    expect(worked?.properties.measured).toBe(false);
  });
});
