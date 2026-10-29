import { describe, expect, it } from "vitest";
import { ALL_INSTALL_GUIDES, browserInfo, browserOf, INSTALL_GUIDE_NAMES, INSTALL_SUPPORT, installGuide } from "@/lib/offline/browser";

/*
 * Which browser this is, for the install steps and for allowing the
 * location again (#498 items 5 and 6, decisions 1112-1114). Made-up but
 * real-shaped user agents.
 */

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
  iphoneFacebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0]",
  ipadSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidEdge: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
  androidOpera: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 OPR/85.0.0.0",
  androidWebView: "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

describe("which browser", () => {
  it("tells apart browsers that all say Chrome or Safari", () => {
    expect(browserOf(UA.androidSamsung)).toBe("samsung");
    expect(browserOf(UA.androidEdge)).toBe("edge");
    expect(browserOf(UA.windowsEdge)).toBe("edge");
    expect(browserOf(UA.androidOpera)).toBe("opera");
    expect(browserOf(UA.androidChrome)).toBe("chrome");
    expect(browserOf(UA.iphoneChrome)).toBe("chrome");
    expect(browserOf(UA.iphoneFirefox)).toBe("firefox");
    expect(browserOf(UA.androidFirefox)).toBe("firefox");
    expect(browserOf(UA.iphoneSafari)).toBe("safari");
    expect(browserOf(UA.macSafari)).toBe("safari");
  });

  it("knows an app's built-in browser can't install", () => {
    expect(browserOf(UA.iphoneFacebook)).toBe("in-app");
    expect(browserOf(UA.androidWebView)).toBe("in-app");
    expect(installGuide(browserInfo(UA.iphoneFacebook))).toBe("in-app");
    expect(INSTALL_SUPPORT["in-app"]).toBe("no");
  });

  it("works out the device and system, including an iPad that says it's a Mac", () => {
    expect(browserInfo(UA.ipadSafari, 5)).toEqual({ platform: "ipad", os: "ios", browser: "safari" });
    expect(browserInfo(UA.macSafari, 0)).toEqual({ platform: "desktop", os: "mac", browser: "safari" });
    expect(browserInfo(UA.androidFirefox)).toEqual({ platform: "android", os: "android", browser: "firefox" });
    expect(browserInfo(UA.windowsFirefox).os).toBe("windows");
    expect(browserInfo(UA.linuxFirefox).os).toBe("linux");
    expect(browserInfo(UA.chromebook).os).toBe("chromeos");
  });
});

describe("install steps for each browser (#498 item 5)", () => {
  const guide = (ua: string, touch = 0) => installGuide(browserInfo(ua, touch));
  it("chooses the right steps", () => {
    expect(guide(UA.iphoneSafari)).toBe("ios-safari");
    expect(guide(UA.ipadSafari, 5)).toBe("ios-safari");
    expect(guide(UA.iphoneChrome)).toBe("ios-other");
    expect(guide(UA.iphoneFirefox)).toBe("ios-other");
    expect(guide(UA.androidChrome)).toBe("android-chrome");
    expect(guide(UA.androidFirefox)).toBe("android-firefox");
    expect(guide(UA.androidSamsung)).toBe("android-samsung");
    expect(guide(UA.androidEdge)).toBe("android-edge");
    expect(guide(UA.androidOpera)).toBe("android-opera");
    expect(guide(UA.windowsChrome)).toBe("desktop-chromium");
    expect(guide(UA.windowsEdge)).toBe("desktop-chromium");
    expect(guide(UA.macChrome)).toBe("desktop-chromium");
    expect(guide(UA.chromebook)).toBe("desktop-chromium");
    expect(guide(UA.windowsFirefox)).toBe("desktop-firefox-windows");
    expect(guide(UA.macFirefox)).toBe("desktop-firefox");
    expect(guide(UA.linuxFirefox)).toBe("desktop-firefox");
    expect(guide(UA.macSafari)).toBe("mac-safari");
  });

  it("doesn't tell Firefox on Android to use Chrome: it installs from its own menu", () => {
    expect(INSTALL_SUPPORT["android-firefox"]).toBe("yes");
  });

  it("is honest where a browser can't install, or only sometimes can", () => {
    expect(INSTALL_SUPPORT["desktop-firefox"]).toBe("no");
    expect(INSTALL_SUPPORT["desktop-firefox-windows"]).toBe("maybe");
    expect(INSTALL_SUPPORT["mac-safari"]).toBe("maybe");
    expect(INSTALL_SUPPORT["ios-other"]).toBe("maybe");
  });

  it("lists every guide once, each with a name", () => {
    expect(new Set(ALL_INSTALL_GUIDES).size).toBe(ALL_INSTALL_GUIDES.length);
    expect([...ALL_INSTALL_GUIDES].sort()).toEqual(Object.keys(INSTALL_SUPPORT).sort());
    for (const key of ALL_INSTALL_GUIDES) expect(INSTALL_GUIDE_NAMES[key]).toBeTruthy();
  });
});
