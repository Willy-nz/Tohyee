/*
 * The service worker's rules (#472, decisions 990-994), kept apart from
 * public/sw.js so they can be tested (tests/unit/offline-sw-rules.test.ts
 * runs this file). A classic script: the service worker loads it with
 * importScripts, and it sets `self.TohyeeSw`.
 */
(function (scope) {
  "use strict";

  /** Pages that open with no connection: the farm workspace (Today, Map, Log, Safety, More) and the install page. */
  var OFFLINE_PAGES = ["/operations/farm", "/operations/farm/map", "/operations/farm/log", "/operations/farm/safety", "/operations/farm/more", "/get-tohyee"];
  /** Built files (names change with every build), icons, fonts and the manifest. */
  var STATIC_CACHE = "tohyee-static-v1";
  var PAGE_CACHE_PREFIX = "tohyee-pages-";
  /** After this long without signing in online, the copies on the device stay locked (decision 994). Matches a Tohyee session's 14 days without use. */
  var OFFLINE_SESSION_DAYS = 14;
  var MAX_STATIC_ENTRIES = 600;

  function isOfflinePage(pathname) {
    var path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    return OFFLINE_PAGES.indexOf(path) !== -1;
  }

  function isStaticAsset(pathname) {
    return pathname.indexOf("/_next/static/") === 0 || pathname.indexOf("/icons/") === 0 || pathname === "/manifest.webmanifest" || pathname === "/icon.svg" || pathname === "/apple-icon.png";
  }

  /** FNV-1a, so a cache's name doesn't spell out whose it is. */
  function hash(text) {
    var value = 0x811c9dc5;
    for (var index = 0; index < text.length; index++) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return ("0000000" + value.toString(16)).slice(-8);
  }

  /** One cache of pages per server and account: the pages show the person's name and organisations (decision 993). */
  function pageCacheName(origin, userId) {
    return PAGE_CACHE_PREFIX + hash(origin + "|" + userId);
  }

  function isPageCache(name) {
    return name.indexOf(PAGE_CACHE_PREFIX) === 0;
  }

  /** Whether the device's copies may be opened: only within 14 days of the last online sign-in. */
  function sessionState(verifiedAt, nowMs) {
    if (!verifiedAt) return { open: false, expiresAt: null };
    var expires = Date.parse(verifiedAt) + OFFLINE_SESSION_DAYS * 86400000;
    if (!isFinite(expires)) return { open: false, expiresAt: null };
    return { open: nowMs < expires, expiresAt: new Date(expires).toISOString() };
  }

  /** A response from the server that is a signed-in page (not the sign-in page it sends you to). */
  function isSignedInPage(response) {
    if (!response || response.status !== 200) return false;
    var url = response.url || "";
    var path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path === "/login" || path.indexOf("/login/") === 0 || path === "/setup") return false;
    var type = (response.headers && response.headers.get && response.headers.get("content-type")) || "";
    return type.indexOf("text/html") !== -1;
  }

  /** The built files a page loads, so they're kept with it. */
  function assetUrlsFromHtml(html) {
    var found = {};
    var pattern = /\/_next\/static\/[A-Za-z0-9_\-./~%]+?\.(?:js|css|woff2)/g;
    var match;
    while ((match = pattern.exec(html))) found[match[0]] = true;
    return Object.keys(found).sort();
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  var PAGE_NAMES = { "/operations/farm": "Today", "/operations/farm/map": "Map", "/operations/farm/log": "Log", "/operations/farm/safety": "Safety", "/operations/farm/more": "More" };

  /**
   * The page shown when a page can't be opened: no connection and no copy
   * ("offline"), copies locked after 14 days ("locked"), or nobody has signed
   * in on this device yet ("none"). Plain HTML with its own light and dark
   * colours, so it needs nothing else.
   */
  function offlinePageHtml(kind, saved) {
    var title = kind === "locked" ? "Sign in to open Tohyee's offline copies" : kind === "none" ? "Tohyee needs a connection the first time" : "You're offline";
    var body =
      kind === "locked"
        ? "<p>It's been more than " + OFFLINE_SESSION_DAYS + " days since you last signed in to Tohyee with a connection, so what's saved on this device is locked. Nothing waiting to be sent has been lost.</p><p>Connect to the internet (or your farm's network), then open Tohyee and sign in.</p>"
        : kind === "none"
          ? "<p>Sign in once with a connection. After that, the farm pages open on this device without one.</p>"
          : "<p>This page needs a connection to Tohyee. These pages are saved on this device:</p>";
    var links = "";
    if (kind === "offline" && saved && saved.length) {
      links =
        "<ul>" +
        saved
          .map(function (path) {
            return '<li><a href="' + escapeHtml(path) + '">' + escapeHtml(PAGE_NAMES[path] || (path === "/get-tohyee" ? "Get Tohyee on this device" : path)) + "</a></li>";
          })
          .join("") +
        "</ul>";
    } else if (kind === "offline") {
      links = "<p>None yet: open the farm pages once with a connection.</p>";
    }
    return (
      '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
      escapeHtml(title) +
      " · Tohyee</title><style>" +
      ":root{color-scheme:light dark;--bg:#f5f7fa;--fg:#1b2533;--muted:#546072;--card:#fff;--line:#dde2e9;--link:#1f5fae}" +
      "@media (prefers-color-scheme:dark){:root{--bg:#0b1018;--fg:#e4e9f1;--muted:#9ba6b6;--card:#121925;--line:#263041;--link:#7fb3f5}}" +
      "body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}" +
      "main{max-width:34rem;margin:0 auto;padding:24px 16px}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 20px}" +
      "h1{font-size:1.35rem;margin:0 0 12px}p{color:var(--muted)}a{color:var(--link);display:inline-block;min-height:44px;line-height:44px}ul{padding-left:20px}" +
      "button{font:inherit;min-height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}" +
      '</style></head><body><main><section role="status"><h1>' +
      escapeHtml(title) +
      "</h1>" +
      body +
      links +
      '<p><button type="button" onclick="location.reload()">Try again</button></p></section></main></body></html>'
    );
  }

  scope.TohyeeSw = {
    OFFLINE_PAGES: OFFLINE_PAGES,
    STATIC_CACHE: STATIC_CACHE,
    OFFLINE_SESSION_DAYS: OFFLINE_SESSION_DAYS,
    MAX_STATIC_ENTRIES: MAX_STATIC_ENTRIES,
    isOfflinePage: isOfflinePage,
    isStaticAsset: isStaticAsset,
    hash: hash,
    pageCacheName: pageCacheName,
    isPageCache: isPageCache,
    sessionState: sessionState,
    isSignedInPage: isSignedInPage,
    assetUrlsFromHtml: assetUrlsFromHtml,
    offlinePageHtml: offlinePageHtml,
  };
})(self);
