/*
 * Tohyee's service worker (#472, decisions 990-994). Hand-written and
 * small, so it's easy to read and has no dependencies:
 *
 * - Built files, icons and the manifest: kept in one cache and served from
 *   it (their names change with each build).
 * - The farm pages and the install page: fetched from Tohyee first; a copy
 *   is kept per server and account. With no connection the copy opens,
 *   only within 14 days of the last online sign-in (then a "locked" page).
 * - Every other page needs Tohyee: with no connection it says so and links
 *   the pages saved on this device.
 * - The API is never cached here: farm information for offline use is kept
 *   by the page in IndexedDB (#472 stage 3), where permissions and expiry
 *   are applied.
 *
 * The page tells it who's signed in ("context") and when someone signs
 * out ("signedOut"), which deletes that account's pages.
 */
importScripts("/sw-rules.js", "/sw-tiles.js");

var R = self.TohyeeSw;
var META_DB = "tohyee-sw";
var context = null; // { userId, organisationId, verifiedAt }
var contextLoaded = null;

function openMeta() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore("meta");
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

function readContext() {
  if (!contextLoaded) {
    contextLoaded = openMeta()
      .then(function (db) {
        return new Promise(function (resolve) {
          var req = db.transaction("meta", "readonly").objectStore("meta").get("context");
          req.onsuccess = function () {
            context = req.result || null;
            resolve(context);
          };
          req.onerror = function () {
            resolve(null);
          };
        });
      })
      .catch(function () {
        return null;
      });
  }
  return contextLoaded.then(function () {
    return context;
  });
}

function saveContext(next) {
  context = next;
  contextLoaded = Promise.resolve(next);
  return openMeta()
    .then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction("meta", "readwrite");
        if (next) tx.objectStore("meta").put(next, "context");
        else tx.objectStore("meta").delete("context");
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    })
    .catch(function () {});
}

/** Deletes every account's pages except `keepName`'s. */
function deletePageCaches(keepName) {
  return caches.keys().then(function (names) {
    return Promise.all(
      names
        .filter(function (name) {
          return R.isPageCache(name) && name !== keepName;
        })
        .map(function (name) {
          return caches.delete(name);
        }),
    );
  });
}

function currentPageCache() {
  return readContext().then(function (ctx) {
    return ctx ? R.pageCacheName(self.location.origin, ctx.userId) : null;
  });
}

function trimStatic() {
  return caches.open(R.STATIC_CACHE).then(function (cache) {
    return cache.keys().then(function (keys) {
      var extra = keys.length - R.MAX_STATIC_ENTRIES;
      return Promise.all(
        keys.slice(0, Math.max(0, extra)).map(function (key) {
          return cache.delete(key);
        }),
      );
    });
  });
}

function cacheAssets(urls) {
  return caches.open(R.STATIC_CACHE).then(function (cache) {
    return Promise.all(
      urls.map(function (url) {
        return cache.match(url).then(function (hit) {
          if (hit) return;
          return fetch(url)
            .then(function (response) {
              if (response.ok) return cache.put(url, response);
            })
            .catch(function () {});
        });
      }),
    );
  });
}

/** Keeps a signed-in page (and the built files it loads) for this account. */
function keepPage(path, response) {
  return currentPageCache().then(function (name) {
    if (!name) return;
    return response.text().then(function (html) {
      var copy = new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "x-tohyee-saved-at": new Date().toISOString() } });
      return caches
        .open(name)
        .then(function (cache) {
          return cache.put(path, copy);
        })
        .then(function () {
          return cacheAssets(R.assetUrlsFromHtml(html));
        })
        .then(trimStatic);
    });
  });
}

function markVerified() {
  return readContext().then(function (ctx) {
    if (ctx) return saveContext(Object.assign({}, ctx, { verifiedAt: new Date().toISOString() }));
  });
}

/** Fetches the offline pages in the background, so they open later without a connection. */
function warm() {
  return readContext().then(function (ctx) {
    if (!ctx) return;
    return R.OFFLINE_PAGES.reduce(function (chain, path) {
      return chain.then(function () {
        return fetch(path, { credentials: "same-origin", cache: "no-store" })
          .then(function (response) {
            if (!R.isSignedInPage(response)) return;
            return keepPage(path, response);
          })
          .catch(function () {});
      });
    }, Promise.resolve());
  });
}

function savedPages() {
  return currentPageCache().then(function (name) {
    if (!name) return [];
    return caches.open(name).then(function (cache) {
      return cache.keys().then(function (keys) {
        return keys.map(function (key) {
          return new URL(key.url).pathname;
        });
      });
    });
  });
}

function htmlResponse(html, status) {
  return new Response(html, { status: status || 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** What to show for a page with no connection. */
function offlineNavigation(pathname) {
  return readContext().then(function (ctx) {
    if (!ctx) return htmlResponse(R.offlinePageHtml("none", []));
    if (!R.sessionState(ctx.verifiedAt, Date.now()).open) return htmlResponse(R.offlinePageHtml("locked", []));
    return currentPageCache().then(function (name) {
      return caches.open(name).then(function (cache) {
        var path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
        return cache.match(path).then(function (hit) {
          if (hit) return hit;
          // Opening the app's icon (start page) with no connection goes to the farm's Today.
          if (path === "/" || path === "/operations") {
            return cache.match("/operations/farm").then(function (farm) {
              if (farm) return Response.redirect("/operations/farm", 302);
              return savedPages().then(function (pages) {
                return htmlResponse(R.offlinePageHtml("offline", pages));
              });
            });
          }
          return savedPages().then(function (pages) {
            return htmlResponse(R.offlinePageHtml("offline", pages));
          });
        });
      });
    });
  });
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error("timeout"));
    }, ms);
    promise.then(
      function (value) {
        clearTimeout(timer);
        resolve(value);
      },
      function (error) {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Opens the page's offline database only if it's there (never creates it: the page owns its layout). */
function openOfflineData() {
  return new Promise(function (resolve) {
    var req = indexedDB.open("tohyee-offline");
    req.onupgradeneeded = function () {
      req.transaction.abort();
    };
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      resolve(null);
    };
  });
}

/** A safety photo or document kept in an offline farm pack (#472 stage 3), for this account only, within its offline session. */
function packFile(fileId) {
  return readContext().then(function (ctx) {
    if (!ctx || !R.sessionState(ctx.verifiedAt, Date.now()).open) return null;
    var prefix = encodeURIComponent(self.location.origin) + "|" + encodeURIComponent(ctx.userId) + "|";
    return openOfflineData().then(function (db) {
      if (!db || !db.objectStoreNames.contains("packSections")) return null;
      return new Promise(function (resolve) {
        var found = null;
        var req = db.transaction("packSections", "readonly").objectStore("packSections").openCursor();
        req.onsuccess = function () {
          var cursor = req.result;
          if (!cursor || found) {
            db.close();
            resolve(found);
            return;
          }
          var value = cursor.value || {};
          if (String(value.scope || "").indexOf(prefix) === 0) {
            (value.files || []).forEach(function (file) {
              if (file.id === fileId) found = file;
            });
          }
          cursor.continue();
        };
        req.onerror = function () {
          resolve(null);
        };
      });
    });
  });
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        // Built-file caches from an older version of this worker.
        return Promise.all(
          names
            .filter(function (name) {
              return name.indexOf("tohyee-static-") === 0 && name !== R.STATIC_CACHE;
            })
            .map(function (name) {
              return caches.delete(name);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  var reply = function (value) {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(value);
  };
  if (data.type === "context" && data.userId) {
    event.waitUntil(
      readContext().then(function (ctx) {
        var sameUser = ctx && ctx.userId === data.userId;
        var next = { userId: data.userId, organisationId: data.organisationId || null, verifiedAt: sameUser ? ctx.verifiedAt : null, warmedAt: sameUser ? ctx.warmedAt || null : null };
        if (data.online) next.verifiedAt = new Date().toISOString();
        // Pages are fetched again at most every 30 minutes (each visit refreshes its own page anyway).
        var warmNow = data.online && (data.force || !next.warmedAt || Date.now() - Date.parse(next.warmedAt) > 30 * 60000);
        if (warmNow) next.warmedAt = new Date().toISOString();
        // Only one account's pages on a device (decision 993).
        return saveContext(next)
          .then(function () {
            return deletePageCaches(R.pageCacheName(self.location.origin, data.userId));
          })
          .then(function () {
            return warmNow ? warm() : undefined;
          })
          .then(function () {
            reply({ ok: true });
          });
      }),
    );
  } else if (data.type === "signedOut") {
    event.waitUntil(
      deletePageCaches(null)
        .then(function () {
          return saveContext(null);
        })
        .then(function () {
          reply({ ok: true });
        }),
    );
  } else if (data.type === "status") {
    event.waitUntil(
      readContext().then(function (ctx) {
        return savedPages().then(function (pages) {
          reply({ context: ctx, pages: pages, session: ctx ? R.sessionState(ctx.verifiedAt, Date.now()) : null });
        });
      }),
    );
  }
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // LINZ aerial photos: kept copies when LINZ can't be reached (#485, public/sw-tiles.js).
  if (self.TohyeeTiles && self.TohyeeTiles.handle(event, readContext, R, caches, self.location.origin)) return;
  if (url.origin !== self.location.origin) return;
  var fileMatch = /^\/api\/farming\/safety\/files\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (fileMatch) {
    // Photos open from the offline farm pack when Tohyee can't be reached.
    event.respondWith(
      fetch(req).catch(function (error) {
        return packFile(fileMatch[1]).then(function (file) {
          if (!file) throw error;
          return new Response(file.blob, { status: 200, headers: { "content-type": file.contentType, "cache-control": "no-store", "x-tohyee-offline-copy": file.copy } });
        });
      }),
    );
    return;
  }
  if (url.pathname.indexOf("/api/") === 0) return;

  if (R.isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.open(R.STATIC_CACHE).then(function (cache) {
        return cache.match(req, { ignoreSearch: url.pathname.indexOf("/_next/static/") !== 0 }).then(function (hit) {
          var network = fetch(req).then(function (response) {
            if (response.ok) cache.put(req, response.clone());
            return response;
          });
          if (hit) {
            // Built files never change; the rest are refreshed for next time.
            if (url.pathname.indexOf("/_next/static/") !== 0) event.waitUntil(network.catch(function () {}));
            return hit;
          }
          return network;
        });
      }),
    );
    return;
  }

  if (req.mode !== "navigate") return;
  var offlinePage = R.isOfflinePage(url.pathname);
  event.respondWith(
    withTimeout(fetch(req), 8000)
      .then(function (response) {
        if (offlinePage && R.isSignedInPage(response)) {
          event.waitUntil(markVerified().then(function () {
            return keepPage(url.pathname.replace(/\/+$/, "") || "/", response.clone());
          }));
        }
        return response;
      })
      .catch(function () {
        return offlineNavigation(url.pathname);
      }),
  );
});
