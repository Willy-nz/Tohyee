import { callNative, nativeFeatures, nativePlugin } from "@/lib/native/bridge";

/*
 * Tractor mode's GPS in the Android app (#502, decisions 1144-1145): the
 * open-source background-location plugin
 * (@capacitor-community/background-geolocation, MIT) keeps the GPS going
 * with the screen off or another app in front, through the foreground
 * service Android requires, shown as the notification "Tohyee is recording
 * a tractor job". Each fix goes into tractor mode's own store exactly as a
 * browser fix does (src/components/tractor.tsx); gaps are still gaps.
 *
 * Permissions are asked only when a job starts, after tractor mode has
 * said why (TractorSetup). Browser-safe: outside the app nothing here runs.
 */

/** What the plugin hands over for each fix (its README's Location). */
export type PluginLocation = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude?: number | null;
  speed?: number | null;
  bearing?: number | null;
  /** Milliseconds since 1970, from the GPS. */
  time?: number | null;
  simulated?: boolean;
};

export type NativeFix = { t: number; lon: number; lat: number; acc: number | null; heading: number | null; speed: number | null };

/** The plugin's fix as tractor mode's. Null for anything that isn't a usable position. */
export function fixFromNative(location: PluginLocation | null | undefined, now: number): NativeFix | null {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  if (Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) return null;
  const finite = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const time = finite(location.time);
  return { t: time && time > 0 ? time : now, lon: location.longitude, lat: location.latitude, acc: finite(location.accuracy), heading: finite(location.bearing), speed: finite(location.speed) };
}

export const RECORDING_NOTICE = { title: "Tohyee is recording a tractor job", message: "GPS keeps recording with the screen off. Open Tohyee to pause or finish." } as const;

/** Whether tractor mode can record with the screen off here. */
export function backgroundRecordingAvailable(): boolean {
  return nativeFeatures().backgroundLocation;
}

type PermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale" | "limited";

/** Whether location and notifications are already allowed (so the explanation before Start can be skipped). */
export async function recordingPermissions(): Promise<{ location: PermissionState | null; notifications: PermissionState | null }> {
  const location = await callNative<{ location?: PermissionState }>("BackgroundGeolocation", "checkPermissions");
  const notifications = await callNative<{ display?: PermissionState }>("LocalNotifications", "checkPermissions");
  return { location: location?.location ?? null, notifications: notifications?.display ?? null };
}

/**
 * Asks Android for what recording needs, after the person has read why:
 * notifications first (Android 13+ won't show the recording notice without
 * them; recording still works if they say no), then location. Returns
 * whether location was allowed.
 */
export async function askRecordingPermissions(): Promise<{ location: boolean; notifications: boolean }> {
  const notifications = await callNative<{ display?: PermissionState }>("LocalNotifications", "requestPermissions");
  const location = await callNative<{ location?: PermissionState }>("BackgroundGeolocation", "requestPermissions", { permissions: ["location"] });
  return { location: location?.location === "granted", notifications: notifications?.display === "granted" };
}

type Watcher = { addWatcher: (options: Record<string, unknown>, callback: (location?: PluginLocation | null, error?: { code?: string; message?: string } | null) => void) => unknown; removeWatcher: (options: { id: string }) => Promise<void> };

/**
 * Starts the GPS with the recording notice. `onFix` gets each fix;
 * `onDenied` when location is off or refused (the job shows NOT RECORDING
 * and the gap, as in a browser). Null when the app can't (a browser, or an
 * app built without the plugin): use the browser's GPS then.
 */
export async function startBackgroundLocation(handlers: { onFix: (fix: NativeFix) => void; onDenied: () => void; onError?: (message: string) => void }): Promise<{ stop: () => Promise<void> } | null> {
  const plugin = nativePlugin<Watcher>("BackgroundGeolocation");
  if (!plugin || typeof plugin.addWatcher !== "function") return null;
  let stopped = false;
  const id = await Promise.resolve(
    plugin.addWatcher({ backgroundTitle: RECORDING_NOTICE.title, backgroundMessage: RECORDING_NOTICE.message, requestPermissions: true, stale: false, distanceFilter: 0 }, (location, error) => {
      if (stopped) return;
      if (error) {
        if (error.code === "NOT_AUTHORIZED") handlers.onDenied();
        else handlers.onError?.(error.message ?? "The GPS stopped.");
        return;
      }
      const fix = fixFromNative(location, Date.now());
      if (fix) handlers.onFix(fix);
    }),
  ).catch(() => null);
  if (typeof id !== "string") return null;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await plugin.removeWatcher({ id }).catch(() => undefined);
    },
  };
}
