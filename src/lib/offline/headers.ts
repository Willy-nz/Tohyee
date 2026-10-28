/*
 * Headers for the service worker's files (#472, decision 990): always
 * checked with the server, so a new version of Tohyee replaces the old
 * worker straight away. Used by next.config.ts, so it imports nothing.
 */
export function serviceWorkerHeaderRules(): Array<{ source: string; headers: Array<{ key: string; value: string }> }> {
  return ["/sw.js", "/sw-rules.js", "/sw-tiles.js"].map((source) => ({
    source,
    headers: [
      { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
    ],
  }));
}
