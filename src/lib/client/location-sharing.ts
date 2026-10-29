"use client";

import { api, ApiError } from "@/lib/client/api";
import { type MySharing, SEND_EVERY_SECONDS } from "@/lib/farming/locations-shared";

/*
 * Sharing your location with a farm, on this device (#498 item 7, decisions
 * 1125-1134). One copy for the page, so it carries on as you move between
 * farm screens, and stops when the page closes: it's foreground only
 * (Geolocation watchPosition while Tohyee is open and showing). Nothing here
 * starts without the person pressing "Share my location"; a reload carries
 * on only on the device that started it and only until the time they chose.
 * Positions aren't stored on the device.
 */

export type GpsState = "off" | "waiting" | "ok" | "denied" | "unavailable" | "timeout" | "unsupported";

export type SharingSnapshot = {
  organisationId: string | null;
  loaded: boolean;
  mine: MySharing | null;
  /** This device is the one sending (it started the sharing). */
  thisDevice: boolean;
  gps: GpsState;
  lastSentAt: string | null;
  /** The last send couldn't reach Tohyee. */
  offline: boolean;
  problem: string | null;
  /** Why sharing just ended, said once in the banner. */
  ended: string | null;
};

const EMPTY: SharingSnapshot = { organisationId: null, loaded: false, mine: null, thisDevice: false, gps: "off", lastSentAt: null, offline: false, problem: null, ended: null };

let state: SharingSnapshot = EMPTY;
const listeners = new Set<() => void>();
let watchId: number | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentMs = 0;
let sending = false;
let visibilityHooked = false;

function set(next: Partial<SharingSnapshot>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function subscribeSharing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sharingSnapshot(): SharingSnapshot {
  return state;
}

export function serverSnapshot(): SharingSnapshot {
  return EMPTY;
}

const deviceKey = (organisationId: string) => `tohyee.locationShare.${organisationId}`;

function rememberDevice(organisationId: string, shareId: string | null) {
  try {
    if (shareId) window.localStorage.setItem(deviceKey(organisationId), shareId);
    else window.localStorage.removeItem(deviceKey(organisationId));
  } catch {
    // Storage refused (private window): this device just won't carry on after a reload.
  }
}

function startedHere(organisationId: string, shareId: string): boolean {
  try {
    return window.localStorage.getItem(deviceKey(organisationId)) === shareId;
  } catch {
    return false;
  }
}

function clearWatch() {
  if (watchId !== null && typeof navigator !== "undefined" && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function endLocally(reason: string | null) {
  clearWatch();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (state.organisationId) rememberDevice(state.organisationId, null);
  set({ mine: null, thisDevice: false, gps: "off", lastSentAt: null, offline: false, problem: null, ended: reason });
}

function scheduleExpiry(mine: MySharing) {
  if (expiryTimer) clearTimeout(expiryTimer);
  const wait = new Date(mine.endsAt).getTime() - Date.now();
  expiryTimer = setTimeout(() => endLocally("Your sharing time ended, so your location is no longer shared."), Math.max(0, Math.min(wait, 2 ** 31 - 1)));
}

async function send(position: GeolocationPosition) {
  const { organisationId, mine } = state;
  if (!organisationId || !mine || sending) return;
  sending = true;
  lastSentMs = Date.now();
  try {
    const result = await api<{ ended: boolean; position: { at: string } | null }>("/api/farming/locations", {
      method: "PUT",
      body: {
        organisationId,
        shareId: mine.shareId,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMetres: position.coords.accuracy,
        takenAt: new Date(position.timestamp).toISOString(),
      },
    });
    if (result.ended) return endLocally("Sharing ended: you no longer work on this farm.");
    set({ lastSentAt: result.position?.at ?? new Date().toISOString(), offline: false, problem: null });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return endLocally("Sharing was stopped, on another device or because its time ran out.");
    if (error instanceof ApiError && error.status === 429) return;
    if (error instanceof ApiError && error.status === 0) return set({ offline: true, problem: null });
    set({ problem: error instanceof Error ? error.message : "Your position wasn't sent." });
  } finally {
    sending = false;
  }
}

function watch() {
  if (typeof navigator === "undefined" || !navigator.geolocation) return set({ gps: "unsupported" });
  if (watchId !== null) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  set({ gps: state.gps === "ok" ? "ok" : "waiting" });
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      if (state.gps !== "ok") set({ gps: "ok" });
      if (Date.now() - lastSentMs >= SEND_EVERY_SECONDS * 1000) void send(position);
    },
    (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        clearWatch();
        set({ gps: "denied" });
      } else set({ gps: error.code === error.TIMEOUT ? "timeout" : "unavailable" });
    },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
  );
  if (!visibilityHooked && typeof document !== "undefined") {
    visibilityHooked = true;
    // Foreground only: hidden (another app, a locked screen) stops the watch; showing again carries on while sharing.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") clearWatch();
      else if (state.thisDevice && state.mine) {
        lastSentMs = 0;
        watch();
      }
    });
  }
}

/** Loads the signed-in person's sharing for this organisation (once per organisation). */
export async function loadSharing(organisationId: string, force = false): Promise<void> {
  if (state.organisationId !== organisationId) {
    clearWatch();
    state = { ...EMPTY, organisationId };
  } else if (state.loaded && !force) return;
  try {
    const { sharing } = await api<{ sharing: MySharing | null }>("/api/farming/locations", { query: { organisationId } });
    if (state.organisationId !== organisationId) return;
    if (!sharing) {
      if (state.mine) return endLocally(state.thisDevice ? "Sharing was stopped, on another device or because its time ran out." : null);
      return set({ loaded: true });
    }
    const here = startedHere(organisationId, sharing.shareId);
    set({ loaded: true, mine: sharing, thisDevice: here });
    scheduleExpiry(sharing);
    if (here) watch();
  } catch {
    set({ loaded: true });
  }
}

/** Starts sharing with a farm from this device, after the person has read the notice and pressed the button. */
export async function startSharing(organisationId: string, farmId: string, hours: number): Promise<void> {
  const { sharing } = await api<{ sharing: MySharing }>(`/api/farming/farms/${farmId}/locations`, { method: "POST", body: { organisationId, hours } });
  if (state.organisationId !== organisationId) state = { ...EMPTY, organisationId, loaded: true };
  clearWatch();
  rememberDevice(organisationId, sharing.shareId);
  lastSentMs = 0;
  set({ loaded: true, mine: sharing, thisDevice: true, lastSentAt: null, problem: null, ended: null, offline: false, gps: "off" });
  scheduleExpiry(sharing);
  watch();
}

/** Sends from this device instead (sharing started elsewhere, or GPS was refused and is allowed again). */
export function sendFromHere(): void {
  if (!state.mine || !state.organisationId) return;
  rememberDevice(state.organisationId, state.mine.shareId);
  lastSentMs = 0;
  clearWatch();
  set({ thisDevice: true, gps: "off" });
  watch();
}

/** Stops sharing: this device stops at once, and Tohyee deletes the position. */
export async function stopSharing(): Promise<void> {
  const organisationId = state.organisationId;
  clearWatch();
  if (!organisationId) return;
  try {
    await api("/api/farming/locations", { method: "DELETE", query: { organisationId } });
    endLocally("You've stopped sharing. Your position has been deleted.");
  } catch (error) {
    // This device has stopped sending; Tohyee couldn't be told, so the last position stays until the time runs out.
    set({ thisDevice: false, gps: "off", problem: `${error instanceof Error ? error.message : "Tohyee couldn't be reached."} This phone has stopped sending, but your last position stays on the map until ${state.mine ? new Date(state.mine.endsAt).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" }) : "your time ends"} unless you stop again with a connection.` });
  }
}

export function dismissEnded(): void {
  set({ ended: null });
}
