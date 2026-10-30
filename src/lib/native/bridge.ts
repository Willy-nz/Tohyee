/*
 * The Android app's native parts, from the web app (#502, decision 1143).
 * The app is Capacitor: it opens the person's own Tohyee server in Android's
 * WebView and adds `window.Capacitor` to those pages, with a proxy for each
 * native plugin built into the app. Nothing here imports Capacitor, so the
 * web app in a browser is unchanged: every function says "not here" (null,
 * false) when there's no app around it, and callers keep the browser's way.
 *
 * Browser-safe. `win` is only passed by tests (tests/unit/native-bridge.test.ts).
 */

/** The plugins the app is built with (android/, package.json's devDependencies). */
export type NativePluginName = "App" | "BackgroundGeolocation" | "Camera" | "LocalNotifications" | "TohyeeServer";

type PluginProxy = Record<string, unknown>;

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, PluginProxy | undefined>;
  PluginHeaders?: Array<{ name: string; methods?: Array<{ name: string }> }>;
};

type WindowLike = { Capacitor?: CapacitorGlobal };

function current(win?: WindowLike): WindowLike | null {
  if (win) return win;
  return typeof window === "undefined" ? null : (window as unknown as WindowLike);
}

function capacitor(win?: WindowLike): CapacitorGlobal | null {
  try {
    const cap = current(win)?.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return null;
    return cap;
  } catch {
    return null;
  }
}

/** True inside Tohyee's Android app (not a browser, not the home-screen web app). */
export function inNativeApp(win?: WindowLike): boolean {
  const cap = capacitor(win);
  if (!cap) return false;
  try {
    return cap.getPlatform?.() === "android";
  } catch {
    return false;
  }
}

/**
 * The native plugin's proxy, or null outside the app or in an app built
 * without it (an older APK). A plugin counts only when the app listed it
 * in its headers: Capacitor's page script can make empty proxies.
 */
export function nativePlugin<T>(name: NativePluginName, win?: WindowLike): T | null {
  if (!inNativeApp(win)) return null;
  const cap = capacitor(win)!;
  try {
    const listed = Array.isArray(cap.PluginHeaders) ? cap.PluginHeaders.some((header) => header?.name === name) : true;
    const plugin = cap.Plugins?.[name];
    return listed && plugin && typeof plugin === "object" ? (plugin as T) : null;
  } catch {
    return null;
  }
}

/** Whether the plugin is there and has this method (an older app may not). */
export function hasNativeMethod(name: NativePluginName, method: string, win?: WindowLike): boolean {
  const plugin = nativePlugin<PluginProxy>(name, win);
  return Boolean(plugin && typeof plugin[method] === "function");
}

/** What the app can do here, for screens choosing between the native way and the browser's. */
export type NativeFeatures = {
  app: boolean;
  /** Tractor mode keeps recording with the screen off (a foreground service). */
  backgroundLocation: boolean;
  notifications: boolean;
  camera: boolean;
  /** The saved server address can be changed from inside Tohyee. */
  changeAddress: boolean;
};

export function nativeFeatures(win?: WindowLike): NativeFeatures {
  const app = inNativeApp(win);
  return {
    app,
    backgroundLocation: app && hasNativeMethod("BackgroundGeolocation", "addWatcher", win),
    notifications: app && hasNativeMethod("LocalNotifications", "schedule", win),
    camera: app && hasNativeMethod("Camera", "takePhoto", win),
    changeAddress: app && hasNativeMethod("TohyeeServer", "clear", win),
  };
}

/** Calls a native method that returns a promise; null (never throws) when it isn't there or fails. */
export async function callNative<T>(name: NativePluginName, method: string, options?: unknown, win?: WindowLike): Promise<T | null> {
  const plugin = nativePlugin<PluginProxy>(name, win);
  const fn = plugin?.[method];
  if (typeof fn !== "function") return null;
  try {
    return ((await (fn as (options?: unknown) => Promise<T>).call(plugin, options ?? {})) ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Like callNative, but a refusal comes back as `{ error }` so the screen can say why (permission refused, cancelled). */
export async function tryNative<T>(name: NativePluginName, method: string, options?: unknown, win?: WindowLike): Promise<{ ok: true; value: T } | { ok: false; error: { code: string | null; message: string } }> {
  const plugin = nativePlugin<PluginProxy>(name, win);
  const fn = plugin?.[method];
  if (typeof fn !== "function") return { ok: false, error: { code: "UNAVAILABLE", message: "Not available here." } };
  try {
    return { ok: true, value: (await (fn as (options?: unknown) => Promise<T>).call(plugin, options ?? {})) as T };
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown } | null;
    return { ok: false, error: { code: typeof value?.code === "string" ? value.code : null, message: typeof value?.message === "string" ? value.message : String(error) } };
  }
}
