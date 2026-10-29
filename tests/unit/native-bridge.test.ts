import { afterEach, describe, expect, it } from "vitest";
import { callNative, hasNativeMethod, inNativeApp, nativeFeatures, nativePlugin, tryNative } from "@/lib/native/bridge";
import { fixFromNative, startBackgroundLocation } from "@/lib/native/location";

/*
 * The web app's bridge to the Android app (#502, decision 1143): it finds
 * the app only when Capacitor says it's native Android, uses a plugin only
 * when the app lists it, and in a browser everything says "not here", so
 * screens keep the browser's way.
 */

type Fake = { Capacitor?: Record<string, unknown> };

function app(plugins: Record<string, Record<string, unknown>>, platform = "android", native = true): Fake {
  return {
    Capacitor: {
      isNativePlatform: () => native,
      getPlatform: () => platform,
      Plugins: plugins,
      PluginHeaders: Object.keys(plugins).map((name) => ({ name, methods: Object.keys(plugins[name]).map((method) => ({ name: method })) })),
    },
  };
}

describe("detecting the app", () => {
  it("is off in a browser, on the web app's Capacitor-less pages, and on other platforms", () => {
    expect(inNativeApp({})).toBe(false);
    expect(inNativeApp({ Capacitor: {} })).toBe(false);
    expect(inNativeApp(app({}, "web", false))).toBe(false);
    expect(inNativeApp(app({}, "ios"))).toBe(false);
    expect(inNativeApp(app({}))).toBe(true);
    // Outside a browser altogether (the server, tests): no window.
    expect(inNativeApp()).toBe(false);
    expect(nativeFeatures()).toEqual({ app: false, backgroundLocation: false, notifications: false, camera: false, changeAddress: false });
  });

  it("never throws, whatever the page's Capacitor does", () => {
    const broken = { Capacitor: { isNativePlatform: () => { throw new Error("boom"); } } };
    expect(inNativeApp(broken)).toBe(false);
    expect(nativePlugin("Camera", broken)).toBeNull();
  });

  it("uses a plugin only when the app lists it and it has the method", () => {
    const win = app({ Camera: { takePhoto: async () => ({}) }, LocalNotifications: { schedule: async () => ({}) } });
    expect(nativePlugin("Camera", win)).not.toBeNull();
    expect(nativePlugin("BackgroundGeolocation", win)).toBeNull();
    expect(hasNativeMethod("Camera", "takePhoto", win)).toBe(true);
    expect(hasNativeMethod("Camera", "chooseFromGallery", win)).toBe(false);
    expect(nativeFeatures(win)).toEqual({ app: true, backgroundLocation: false, notifications: true, camera: true, changeAddress: false });
    // A proxy Capacitor made up without the app listing it isn't used.
    const unlisted = app({});
    (unlisted.Capacitor!.Plugins as Record<string, unknown>).Camera = { takePhoto: async () => ({}) };
    expect(nativePlugin("Camera", unlisted)).toBeNull();
  });

  it("calls a method, and gives null (or the error) when it fails or isn't there", async () => {
    const win = app({ App: { getInfo: async () => ({ version: "0.19.0" }), exitApp: async () => { throw Object.assign(new Error("Nope"), { code: "DENIED" }); } } });
    expect(await callNative("App", "getInfo", {}, win)).toEqual({ version: "0.19.0" });
    expect(await callNative("App", "exitApp", {}, win)).toBeNull();
    expect(await callNative("App", "missing", {}, win)).toBeNull();
    expect(await callNative("App", "getInfo", {}, {})).toBeNull();
    expect(await tryNative("App", "exitApp", {}, win)).toEqual({ ok: false, error: { code: "DENIED", message: "Nope" } });
    expect(await tryNative("Camera", "takePhoto", {}, win)).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });
});

describe("tractor mode's GPS in the app", () => {
  it("turns the plugin's location into a tractor fix, and drops nonsense", () => {
    expect(fixFromNative({ latitude: -45.87, longitude: 170.5, accuracy: 6, bearing: 90, speed: 2.5, time: 1_000 }, 5_000)).toEqual({ t: 1_000, lon: 170.5, lat: -45.87, acc: 6, heading: 90, speed: 2.5 });
    expect(fixFromNative({ latitude: -45.87, longitude: 170.5, accuracy: null, time: null }, 5_000)).toEqual({ t: 5_000, lon: 170.5, lat: -45.87, acc: null, heading: null, speed: null });
    expect(fixFromNative({ latitude: Number.NaN, longitude: 170.5, accuracy: 5 }, 1)).toBeNull();
    expect(fixFromNative({ latitude: 95, longitude: 170.5, accuracy: 5 }, 1)).toBeNull();
    expect(fixFromNative(null, 1)).toBeNull();
  });

  const original = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  it("starts the watcher with the recording notice, passes fixes on, says when location is refused, and stops", async () => {
    let callback: ((location?: unknown, error?: unknown) => void) | null = null;
    let options: Record<string, unknown> | null = null;
    const removed: string[] = [];
    (globalThis as { window?: unknown }).window = app({
      BackgroundGeolocation: {
        addWatcher: (given: Record<string, unknown>, cb: (location?: unknown, error?: unknown) => void) => {
          options = given;
          callback = cb;
          return "watch-1";
        },
        removeWatcher: async ({ id }: { id: string }) => {
          removed.push(id);
        },
      },
    });
    const fixes: unknown[] = [];
    let denied = 0;
    const watcher = await startBackgroundLocation({ onFix: (fix) => fixes.push(fix), onDenied: () => (denied += 1) });
    expect(watcher).not.toBeNull();
    expect(options).toMatchObject({ backgroundTitle: "Tohyee is recording a tractor job", requestPermissions: true, stale: false });
    callback!({ latitude: -45.87, longitude: 170.5, accuracy: 4, time: 10 });
    callback!(null, { code: "NOT_AUTHORIZED", message: "denied" });
    expect(fixes).toEqual([{ t: 10, lon: 170.5, lat: -45.87, acc: 4, heading: null, speed: null }]);
    expect(denied).toBe(1);
    await watcher!.stop();
    callback!({ latitude: -45.8, longitude: 170.5, accuracy: 4, time: 20 });
    expect(fixes).toHaveLength(1);
    expect(removed).toEqual(["watch-1"]);
  });

  it("is null in a browser, so tractor mode uses the browser's GPS", async () => {
    (globalThis as { window?: unknown }).window = {};
    expect(await startBackgroundLocation({ onFix: () => undefined, onDenied: () => undefined })).toBeNull();
  });
});
