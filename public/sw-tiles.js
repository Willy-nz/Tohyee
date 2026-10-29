/*
 * LINZ aerial photos for the farm maps on this device (#485, decisions
 * 1063-1065). A classic script the service worker loads with
 * importScripts; it sets `self.TohyeeTiles` (tests/unit/farm-imagery-sw.test.ts
 * runs it).
 *
 * The page keeps the farm's area in Cache Storage (src/lib/farming/
 * imagery-device.ts). Here the map's photos go to LINZ first; when LINZ
 * can't be reached, or refuses (an expired key), a kept copy answers,
 * only for the account signed in on this device and only within its
 * 14-day offline session.
 */
(function (scope) {
  "use strict";

  var TILE = /^\/v1\/tiles\/aerial\/3857\/(\d+)\/(\d+)\/(\d+)\.webp$/;
  var HOST = "https://basemaps.linz.govt.nz";
  var PREFIX = "tohyee-tiles-";

  /** The kept copy's address for a LINZ aerial photo (the key left off), or null for anything else. */
  function tileCacheUrl(href) {
    var url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.origin !== HOST || !TILE.test(url.pathname)) return null;
    return HOST + url.pathname;
  }

  /** The start of this account's photo caches' names (one per organisation). */
  function accountPrefix(hash, origin, userId) {
    return PREFIX + hash(origin + "|" + userId) + "-";
  }

  /** A kept copy from this account's caches, or null. */
  function findKept(cacheStorage, prefix, key) {
    return cacheStorage.keys().then(function (names) {
      var mine = names.filter(function (name) {
        return name.indexOf(prefix) === 0;
      });
      return mine.reduce(function (chain, name) {
        return chain.then(function (found) {
          if (found) return found;
          return cacheStorage.open(name).then(function (cache) {
            return cache.match(key).then(function (hit) {
              return hit || null;
            });
          });
        });
      }, Promise.resolve(null));
    });
  }

  /**
   * Answers a request for a LINZ aerial photo: LINZ first, then the kept
   * copy. `readContext` gives the signed-in account ({ userId, verifiedAt }),
   * `rules` is self.TohyeeSw. False when the request isn't a LINZ photo.
   */
  function handle(event, readContext, rules, cacheStorage, origin) {
    var key = tileCacheUrl(event.request.url);
    if (!key) return false;
    var kept = function () {
      return readContext().then(function (ctx) {
        if (!ctx || !rules.sessionState(ctx.verifiedAt, Date.now()).open) return null;
        return findKept(cacheStorage, accountPrefix(rules.hash, origin, ctx.userId), key);
      });
    };
    event.respondWith(
      fetch(event.request).then(
        function (response) {
          // An image tag's request can't read LINZ's answer (status 0); a refusal it can read falls back to the kept copy.
          if (response.status === 401 || response.status === 403) {
            return kept().then(function (hit) {
              return hit || response;
            });
          }
          return response;
        },
        function (error) {
          return kept().then(function (hit) {
            if (hit) return hit;
            throw error;
          });
        },
      ),
    );
    return true;
  }

  scope.TohyeeTiles = { tileCacheUrl: tileCacheUrl, accountPrefix: accountPrefix, findKept: findKept, handle: handle };
})(self);
