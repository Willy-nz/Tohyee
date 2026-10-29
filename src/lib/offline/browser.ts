/*
 * Which browser this is, on which kind of device (#498, decisions
 * 1112-1114): for the install steps on Get Tohyee on this device, and for
 * the steps to let Tohyee use the location again after it was blocked.
 * Browser-safe and pure; tested in tests/unit/offline-browser.test.ts.
 *
 * It reads the browser's own description of itself (the user agent). That
 * can be wrong, so every screen that uses it also lists the steps for the
 * other browsers.
 */

import { platformOf, type Platform } from "./device";

export type Browser = "safari" | "chrome" | "edge" | "firefox" | "samsung" | "opera" | "in-app" | "other";
export type Os = "ios" | "android" | "windows" | "mac" | "linux" | "chromeos" | "other";

export type BrowserInfo = { platform: Platform; os: Os; browser: Browser };

export const BROWSER_NAMES: Record<Browser, string> = {
  safari: "Safari",
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  samsung: "Samsung Internet",
  opera: "Opera",
  "in-app": "an app's built-in browser",
  other: "this browser",
};

function osOf(userAgent: string, platform: Platform): Os {
  if (platform === "iphone" || platform === "ipad") return "ios";
  if (platform === "android") return "android";
  if (/CrOS/.test(userAgent)) return "chromeos";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Linux|X11/.test(userAgent)) return "linux";
  return "other";
}

/** The browser, from its user agent. Order matters: Edge, Opera and Samsung Internet also say "Chrome", and nearly all say "Safari". */
export function browserOf(userAgent: string): Browser {
  // Facebook, Instagram, Messenger, LINE, the Google app and Android web views open links in their own browser, which can't install.
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|GSA\/|; wv\)/.test(userAgent)) return "in-app";
  if (/SamsungBrowser\//.test(userAgent)) return "samsung";
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "edge";
  if (/OPR\/|OPiOS\/|OPT\//.test(userAgent)) return "opera";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "firefox";
  if (/CriOS\/|Chrome\/|Chromium\//.test(userAgent)) return "chrome";
  if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) return "safari";
  return "other";
}

export function browserInfo(userAgent: string, maxTouchPoints = 0): BrowserInfo {
  const platform = platformOf(userAgent, maxTouchPoints);
  return { platform, os: osOf(userAgent, platform), browser: browserOf(userAgent) };
}

/**
 * Which install steps fit (decision 1112). Every one is a Home Screen web
 * app from this server, never an app-store app or an APK.
 * - `yes`: this browser installs web apps.
 * - `maybe`: it depends on the version, or a setting.
 * - `no`: it can't; use the website in the browser, or another browser.
 */
export type InstallGuide =
  | "ios-safari"
  | "ios-other"
  | "android-chrome"
  | "android-edge"
  | "android-samsung"
  | "android-firefox"
  | "android-opera"
  | "in-app"
  | "android-other"
  | "desktop-chromium"
  | "desktop-firefox-windows"
  | "desktop-firefox"
  | "mac-safari"
  | "desktop-other";

export const INSTALL_SUPPORT: Record<InstallGuide, "yes" | "maybe" | "no"> = {
  "ios-safari": "yes",
  "ios-other": "maybe",
  "android-chrome": "yes",
  "android-edge": "yes",
  "android-samsung": "yes",
  "android-firefox": "yes",
  "android-opera": "maybe",
  "in-app": "no",
  "android-other": "maybe",
  "desktop-chromium": "yes",
  "desktop-firefox-windows": "maybe",
  "desktop-firefox": "no",
  "mac-safari": "maybe",
  "desktop-other": "maybe",
};

export function installGuide(info: BrowserInfo): InstallGuide {
  if (info.browser === "in-app") return "in-app";
  if (info.os === "ios") return info.browser === "safari" ? "ios-safari" : "ios-other";
  if (info.os === "android") {
    if (info.browser === "chrome") return "android-chrome";
    if (info.browser === "edge") return "android-edge";
    if (info.browser === "samsung") return "android-samsung";
    if (info.browser === "firefox") return "android-firefox";
    if (info.browser === "opera") return "android-opera";
    return "android-other";
  }
  if (info.browser === "chrome" || info.browser === "edge") return "desktop-chromium";
  if (info.browser === "firefox") return info.os === "windows" ? "desktop-firefox-windows" : "desktop-firefox";
  if (info.browser === "safari" && info.os === "mac") return "mac-safari";
  return "desktop-other";
}

/** The guides listed under "Steps for other browsers and devices", in this order. */
export const ALL_INSTALL_GUIDES: InstallGuide[] = [
  "ios-safari",
  "ios-other",
  "android-chrome",
  "android-samsung",
  "android-edge",
  "android-firefox",
  "android-opera",
  "android-other",
  "desktop-chromium",
  "desktop-firefox-windows",
  "desktop-firefox",
  "mac-safari",
  "desktop-other",
  "in-app",
];

export const INSTALL_GUIDE_NAMES: Record<InstallGuide, string> = {
  "ios-safari": "iPhone or iPad: Safari",
  "ios-other": "iPhone or iPad: Chrome, Edge or Firefox",
  "android-chrome": "Android: Chrome",
  "android-edge": "Android: Edge",
  "android-samsung": "Android: Samsung Internet",
  "android-firefox": "Android: Firefox",
  "android-opera": "Android: Opera",
  "android-other": "Android: another browser",
  "in-app": "Inside another app (Facebook, Messenger, Instagram, Gmail)",
  "desktop-chromium": "Computer: Chrome or Edge",
  "desktop-firefox-windows": "Computer: Firefox on Windows",
  "desktop-firefox": "Computer: Firefox on a Mac or Linux",
  "mac-safari": "Mac: Safari",
  "desktop-other": "Computer: another browser",
};
