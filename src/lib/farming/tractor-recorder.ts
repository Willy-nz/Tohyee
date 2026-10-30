import { gpsQuality, THRESHOLDS, type TrackPoint } from "@/lib/farming/coverage";
import type { TrackEvent } from "@/lib/farming/tractor-shared";

/*
 * Tractor mode's recorder (#472 stage 5, decisions 1021-1023), without the
 * browser: what each GPS fix, button and interruption does to the job. The
 * screen calls these and saves what they return; tests drive them directly.
 *
 * Recording is foreground only (Jess, 28 October 2026): the phone is mounted
 * with the screen kept on. When the screen goes off, another app comes to
 * the front, the GPS stops or permission is taken away, nothing is recorded
 * and the next fix starts a new piece of track, so the time in between is a
 * gap, never a straight line.
 */

export type RecorderStatus = "recording" | "paused" | "finished";

export type Interruption = "hidden" | "gps_lost" | "gps_denied" | null;

export type RecorderState = {
  status: RecorderStatus;
  working: boolean;
  /** Index into the job's settings. */
  settings: number;
  /** The next fix starts a new piece (after a pause or an interruption). */
  breakNext: boolean;
  /** Why recording isn't happening right now, when it isn't. */
  interruption: Interruption;
  lastFix: { t: number; lon: number; lat: number; acc: number | null; heading: number | null; speed: number | null } | null;
  /** When the last fix arrived, by the phone's clock. */
  lastFixAt: number | null;
};

export type Fix = { t: number; lon: number; lat: number; acc: number | null; heading?: number | null; speed?: number | null };

export type Step = { state: RecorderState; points: TrackPoint[]; events: TrackEvent[] };

export function startRecorder(now: number, settings = 0): Step {
  return { state: { status: "recording", working: false, settings, breakNext: false, interruption: null, lastFix: null, lastFixAt: null }, points: [], events: [{ t: now, kind: "start" }] };
}

/** Picks the recorder up again after the app was closed or reloaded mid-job: paused, with a gap. */
export function reopenRecorder(state: RecorderState, now: number): Step {
  if (state.status === "finished") return { state, points: [], events: [] };
  return { state: { ...state, status: "paused", working: false, breakNext: true, interruption: null, lastFix: null, lastFixAt: null }, points: [], events: [{ t: now, kind: "reopened" }] };
}

function pointFrom(state: RecorderState, fix: Fix, breakBefore: boolean): TrackPoint {
  const point: TrackPoint = { t: fix.t, lon: fix.lon, lat: fix.lat, acc: fix.acc, w: state.working, s: state.settings };
  if (typeof fix.speed === "number" && Number.isFinite(fix.speed) && fix.speed >= 0) point.spd = Math.round(fix.speed * 100) / 100;
  if (breakBefore) point.b = true;
  return point;
}

/** A GPS fix arrived. */
export function onFix(state: RecorderState, fix: Fix, now: number): Step {
  const events: TrackEvent[] = [];
  let next: RecorderState = { ...state, lastFix: { t: fix.t, lon: fix.lon, lat: fix.lat, acc: fix.acc, heading: fix.heading ?? null, speed: fix.speed ?? null }, lastFixAt: now };
  if (state.interruption === "gps_lost" || state.interruption === "gps_denied") {
    events.push({ t: fix.t, kind: "gps_back" });
    next = { ...next, interruption: null, breakNext: true };
  }
  if (next.status !== "recording" || next.interruption === "hidden") return { state: next, points: [], events };
  const point = pointFrom(next, fix, next.breakNext);
  return { state: { ...next, breakNext: false }, points: [point], events };
}

/**
 * Working ON or OFF. A point at the last position, with the new state, is
 * added straight away when the last fix is recent, so little is lost.
 */
export function setWorking(state: RecorderState, working: boolean, now: number): Step {
  if (state.working === working || state.status === "finished") return { state, points: [], events: [] };
  const next = { ...state, working };
  const events: TrackEvent[] = [{ t: now, kind: working ? "working_on" : "working_off" }];
  const fresh = state.status === "recording" && !state.interruption && state.lastFix && state.lastFixAt != null && now - state.lastFixAt <= 2000;
  if (!fresh || !state.lastFix) return { state: next, points: [], events };
  // Timed a millisecond after the fix it repeats, not at the tap: a later time would make the next stretch look impossibly fast.
  const point = pointFrom(next, { ...state.lastFix, t: state.lastFix.t + 1 }, next.breakNext);
  return { state: { ...next, breakNext: false }, points: [point], events };
}

/** A different width or offset from here on (`settings` is its index in the job). */
export function setSettings(state: RecorderState, settings: number, now: number): Step {
  if (state.settings === settings || state.status === "finished") return { state, points: [], events: [] };
  return { state: { ...state, settings }, points: [], events: [{ t: now, kind: "settings" }] };
}

/** Pause also turns Working OFF: paused time never counts. */
export function pause(state: RecorderState, now: number): Step {
  if (state.status !== "recording") return { state, points: [], events: [] };
  const events: TrackEvent[] = [];
  if (state.working) events.push({ t: now, kind: "working_off" });
  events.push({ t: now, kind: "pause" });
  return { state: { ...state, status: "paused", working: false, breakNext: true }, points: [], events };
}

export function resume(state: RecorderState, now: number): Step {
  if (state.status !== "paused") return { state, points: [], events: [] };
  return { state: { ...state, status: "recording", breakNext: true }, points: [], events: [{ t: now, kind: "resume" }] };
}

export function finish(state: RecorderState, now: number): Step {
  if (state.status === "finished") return { state, points: [], events: [] };
  const events: TrackEvent[] = [];
  if (state.working) events.push({ t: now, kind: "working_off" });
  events.push({ t: now, kind: "finish" });
  return { state: { ...state, status: "finished", working: false }, points: [], events };
}

/** The screen went off or another app came to the front (`visible: false`), or Tohyee is back. */
export function onVisibility(state: RecorderState, visible: boolean, now: number): Step {
  if (state.status === "finished") return { state, points: [], events: [] };
  if (!visible) {
    if (state.interruption === "hidden") return { state, points: [], events: [] };
    return { state: { ...state, interruption: "hidden", breakNext: true }, points: [], events: [{ t: now, kind: "hidden" }] };
  }
  if (state.interruption !== "hidden") return { state, points: [], events: [] };
  // Back: the next fix starts a new piece. Whether GPS is working shows from the next fix.
  return { state: { ...state, interruption: null, breakNext: true, lastFix: null, lastFixAt: null }, points: [], events: [{ t: now, kind: "visible" }] };
}

/** The browser said location permission was refused or removed. */
export function onPermissionDenied(state: RecorderState, now: number): Step {
  if (state.interruption === "gps_denied" || state.status === "finished") return { state, points: [], events: [] };
  return { state: { ...state, interruption: "gps_denied", breakNext: true }, points: [], events: [{ t: now, kind: "gps_denied" }] };
}

/** Checked every second or so: no fix for longer than the gap limit means the GPS is lost. */
export function onTick(state: RecorderState, now: number): Step {
  if (state.status !== "recording" || state.interruption) return { state, points: [], events: [] };
  const since = state.lastFixAt;
  if (since != null && now - since > THRESHOLDS.maxGapS * 1000) {
    return { state: { ...state, interruption: "gps_lost", breakNext: true }, points: [], events: [{ t: now, kind: "gps_lost" }] };
  }
  return { state, points: [], events: [] };
}

export type Banner = { tone: "ok" | "warning" | "danger" | "paused"; title: string; detail: string };

/** What the big status strip says. */
/** `background`: the Android app records with the screen off (#502), so the screen needn't stay on. */
export function statusBanner(state: RecorderState, options: { now: number; wakeLock: "on" | "off" | "unsupported"; background?: boolean }): Banner {
  if (state.status === "finished") return { tone: "paused", title: "Finished", detail: "Nothing more is being recorded." };
  if (state.interruption === "gps_denied") return { tone: "danger", title: "NOT RECORDING: location is off", detail: "Location permission was removed. Allow location for Tohyee in the phone's settings, then tap Resume." };
  if (state.interruption === "hidden") return { tone: "danger", title: "NOT RECORDING: screen off", detail: "Recording stopped while the screen was off or another app was open. That time is a gap." };
  if (state.status === "paused") return { tone: "paused", title: "Paused", detail: "Nothing is recorded while paused. Tap Resume to carry on." };
  if (state.interruption === "gps_lost" || state.lastFixAt == null) {
    const waiting = state.lastFixAt == null && state.interruption == null;
    return { tone: "danger", title: waiting ? "Waiting for GPS" : "NOT RECORDING: no GPS", detail: waiting ? "No position yet. Stay still in the open for a moment." : "No GPS position for more than 10 seconds. Nothing is counted until it's back." };
  }
  const quality = gpsQuality(state.lastFix?.acc);
  const accuracy = state.lastFix?.acc != null ? `±${Math.round(state.lastFix.acc)} m` : "unknown";
  if (quality === "poor") return { tone: "danger", title: `GPS weak (${accuracy}): not counting`, detail: `Fixes vaguer than ±${THRESHOLDS.maxAccuracyM} m aren't used, so this stretch is a gap.` };
  const asleep = options.wakeLock !== "on" && !options.background ? " The screen may turn off by itself: keep it on." : "";
  if (quality === "weak") return { tone: "warning", title: `Recording · GPS fair (${accuracy})`, detail: `Counting, but less accurate.${asleep}` };
  return { tone: asleep ? "warning" : "ok", title: `Recording · GPS ${accuracy}`, detail: state.working ? `Working ON: area is being counted.${asleep}` : `Working OFF: travel only, no area counted.${asleep}` };
}
