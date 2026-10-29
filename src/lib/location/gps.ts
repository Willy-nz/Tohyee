/*
 * "Use my location" on the farm's maps (#498 item 6, decisions 1115-1118):
 * where the browser's location permission and the GPS are up to, what to
 * say about it, and how to let Tohyee use the location again after it was
 * blocked. Pure and browser-safe; the hook and buttons are in
 * src/components/gps-control.tsx. Tested in tests/unit/gps.test.ts.
 *
 * Finding where you are only moves the map on this device. It never sends
 * the position anywhere: sharing it with other people is a separate,
 * explicit choice (#498 item 7).
 */

import type { BrowserInfo } from "@/lib/offline/browser";

/** One position from the browser. `accuracy` is metres (the radius the browser is 68% sure of); `at` is milliseconds since 1970. */
export type GpsFix = { lon: number; lat: number; accuracy: number | null; at: number };

export type GpsState =
  /** Nothing asked yet: the browser will ask the first time. */
  | { status: "not_asked" }
  /** Waiting for the browser (its question, or the GPS). */
  | { status: "asking"; fix: GpsFix | null }
  /** Allowed. `fix` is null until a position has been found on this screen. */
  | { status: "granted"; fix: GpsFix | null }
  /** Blocked for this site. Browsers don't ask again, so the screen shows how to allow it. */
  | { status: "denied"; checkedAt: number | null }
  /** This browser or address can't give a location, or the phone couldn't find one. */
  | { status: "unavailable"; reason: "no_api" | "insecure" | "no_fix" }
  /** No position came within the time allowed. */
  | { status: "timed_out" };

export type GpsEvent =
  /** The browser has no location, or the page isn't on HTTPS. */
  | { type: "unsupported"; reason: "no_api" | "insecure" }
  /** What the Permissions API says (where the browser has one). */
  | { type: "permission"; state: "granted" | "denied" | "prompt"; at?: number }
  /** "Use my location" was tapped. */
  | { type: "ask" }
  | { type: "fix"; fix: GpsFix }
  /** The browser's GeolocationPositionError code: 1 denied, 2 unavailable, 3 timed out. */
  | { type: "error"; code: number; at?: number };

export const GPS_START: GpsState = { status: "not_asked" };

/** How long to wait for a position before saying it timed out. */
export const GPS_TIMEOUT_MS = 15_000;

/** A position found less than this long ago counts as "now"; older ones say how old. */
export const GPS_FRESH_MS = 60_000;

function lastFix(state: GpsState): GpsFix | null {
  return state.status === "granted" || state.status === "asking" ? state.fix : null;
}

export function gpsReducer(state: GpsState, event: GpsEvent): GpsState {
  switch (event.type) {
    case "unsupported":
      return { status: "unavailable", reason: event.reason };
    case "permission":
      if (state.status === "unavailable" && state.reason !== "no_fix") return state;
      if (event.state === "denied") return { status: "denied", checkedAt: event.at ?? null };
      if (event.state === "granted") return state.status === "asking" ? state : state.status === "granted" ? state : { status: "granted", fix: null };
      // "prompt": the browser will ask again (someone reset the permission). Only a block changes back to "not asked".
      return state.status === "denied" ? { status: "not_asked" } : state;
    case "ask":
      // Asking again while blocked does nothing: the browser says no without asking. The screen shows how to allow it instead.
      if (state.status === "denied") return state;
      if (state.status === "unavailable" && state.reason !== "no_fix") return state;
      return { status: "asking", fix: lastFix(state) };
    case "fix":
      return { status: "granted", fix: event.fix };
    case "error":
      if (event.code === 1) return { status: "denied", checkedAt: event.at ?? null };
      if (event.code === 3) return { status: "timed_out" };
      return { status: "unavailable", reason: "no_fix" };
  }
}

/** Whether tapping "Use my location" would ask the browser (not while blocked or impossible). */
export function canAsk(state: GpsState): boolean {
  return state.status !== "denied" && state.status !== "asking" && !(state.status === "unavailable" && state.reason !== "no_fix");
}

/** "±8 m", rounded the way a phone's accuracy deserves. */
export function accuracyText(metres: number | null): string {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return "accuracy not known";
  if (metres < 10) return `±${Math.max(1, Math.round(metres))} m`;
  if (metres < 1000) return `±${Math.round(metres / 5) * 5} m`;
  return `±${(metres / 1000).toFixed(1)} km`;
}

/** How good a fix is for finding yourself on a paddock map (the same bands as tractor mode). */
export function accuracyQuality(metres: number | null): "good" | "fair" | "poor" | "unknown" {
  if (metres == null || !Number.isFinite(metres)) return "unknown";
  if (metres <= 10) return "good";
  if (metres <= 30) return "fair";
  return "poor";
}

/** "just now", "2 min ago", "at 9:41 am": how old a fix is. Never calls an old position live. */
export function fixAge(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < GPS_FRESH_MS) return "just now";
  if (age < 60 * 60_000) return `${Math.round(age / 60_000)} min ago`;
  return `at ${new Date(at).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" })}`;
}

/** The one line under the map saying where things are up to. */
export function gpsMessage(state: GpsState, now: number): string {
  switch (state.status) {
    case "not_asked":
      return "Location not used yet. The map works without it.";
    case "asking":
      return "Finding where you are…";
    case "granted":
      return state.fix
        ? `You're the blue dot, ${accuracyText(state.fix.accuracy)}, found ${fixAge(state.fix.at, now)}.${accuracyQuality(state.fix.accuracy) === "poor" ? " That's rough: the dot could be well off. Out in the open it gets better." : ""}`
        : "Location is allowed. Tap Use my location to find yourself on the map.";
    case "denied":
      return "Location is blocked for Tohyee in this browser, so the map can't show where you are. The map still works.";
    case "unavailable":
      return state.reason === "insecure"
        ? "Browsers only give the location to an HTTPS address, and this one isn't. The map still works."
        : state.reason === "no_api"
          ? "This browser can't give its location. The map still works."
          : "The phone couldn't work out where it is. Check its Location (GPS) is on, then try again.";
    case "timed_out":
      return `No GPS position came in ${GPS_TIMEOUT_MS / 1000} seconds. Out in the open, or by a window, it usually comes faster. Try again.`;
  }
}

/** Said beside every "Use my location": centring on yourself isn't sharing. */
export const GPS_PRIVATE_NOTE = "Only this device sees it: finding yourself moves the map, and doesn't share your location with anyone.";

/**
 * How to let Tohyee use the location again after it was blocked, for this
 * browser (decision 1117). Browsers don't ask a second time once it's
 * blocked, so the person has to change it in the browser or phone.
 */
export function restoreSteps(info: Pick<BrowserInfo, "os" | "browser">, installed = false): string[] {
  const phoneOn = info.os === "ios" ? "Also check Settings › Privacy & Security › Location Services is on." : info.os === "android" ? "Also check the phone's Location is on (swipe down from the top of the screen)." : null;
  const steps = ((): string[] => {
    if (info.os === "ios") {
      if (info.browser === "safari" || installed) {
        return [
          "Open the Settings app › Privacy & Security › Location Services › Safari Websites, and choose While Using the App (or Ask Next Time).",
          ...(installed ? [] : ["Back in Safari, tap the aA (or page menu) button in the address bar › Website Settings › Location › Allow."]),
          "Come back here and tap Check again.",
        ];
      }
      const app = info.browser === "chrome" ? "Chrome" : info.browser === "firefox" ? "Firefox" : info.browser === "edge" ? "Edge" : "this browser";
      return [`Open the Settings app, scroll down to ${app} › Location, and choose While Using the App.`, "Come back here and tap Check again."];
    }
    if (info.os === "android") {
      if (info.browser === "firefox") return ["Tap the padlock (or the icon) at the left of the address bar.", "Find Location and change it to Allowed (or clear the block).", "Come back here and tap Check again."];
      if (info.browser === "samsung") return ["Tap the menu (☰) › Settings › Sites and downloads › Site permissions › Location.", "Find this site and allow it.", "Come back here and tap Check again."];
      if (info.browser === "edge") return ["Tap the padlock at the left of the address bar › Permissions (or ⋯ › Settings › Privacy and security › Site permissions › Location).", "Set Location to Allow.", "Come back here and tap Check again."];
      return [
        installed ? "Long-press the Tohyee icon › App info (ⓘ) › Permissions › Location › Allow only while using the app." : "Tap the icon at the left of the address bar › Permissions (or Site settings) › Location › Allow.",
        "Come back here and tap Check again.",
      ];
    }
    if (info.browser === "firefox") return ["Click the icon at the left of the address bar.", "Next to Location, clear Blocked (the ✕), then reload the page.", "Tap Check again."];
    if (info.browser === "safari") return ["In the menu bar choose Safari › Settings (or Preferences) › Websites › Location.", "Set this website to Allow (or Ask).", "Come back here and click Check again."];
    if (info.browser === "chrome" || info.browser === "edge" || info.browser === "opera") return ["Click the icon at the left of the address bar › Site settings (or Permissions).", "Set Location to Allow, then reload the page.", "Click Check again."];
    return ["Open this browser's settings for this site and allow Location.", "Come back here and tap Check again."];
  })();
  return phoneOn ? [...steps.slice(0, -1), phoneOn, steps.at(-1)!] : steps;
}
