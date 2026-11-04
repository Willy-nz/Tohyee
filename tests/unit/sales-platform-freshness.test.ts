import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lastSyncText, ReconnectBanner } from "@/components/sales-platforms";
import { needsReconnect, syncFreshness } from "@/lib/sales-platforms/freshness";

/** #572: how up to date a store is, from made-up connections. */
const NOW = new Date("2026-11-04T06:00:00Z");
const healthy = { status: "active", lastSyncAt: "2026-11-04T05:50:00.000Z", lastSuccessfulSyncAt: "2026-11-04T05:50:00.000Z", lastError: null, failures: 0 };
const refused = {
  status: "paused",
  lastSyncAt: "2026-11-04T05:30:00.000Z",
  lastSuccessfulSyncAt: "2026-11-03T09:00:00.000Z",
  lastError: "example-shop.myshopify.com said 401: [API] Invalid API key or access token (unrecognized login or wrong password)",
  failures: 4,
};

describe("sales platform freshness (#572)", () => {
  it("a store synced 10 minutes ago is up to date", () => {
    expect(syncFreshness(healthy, NOW, "Shopify")).toMatchObject({ behind: false, behindReason: null, needsReconnect: false, action: null, minutesSinceLastSuccessfulSync: 10 });
  });

  it("a store whose login is refused (401) is behind, needs reconnecting, and its last success is before its last attempt", () => {
    const freshness = syncFreshness(refused, NOW, "Shopify");
    expect(freshness).toMatchObject({ behind: true, behindReason: "paused", needsReconnect: true, lastSuccessfulSyncAt: "2026-11-03T09:00:00.000Z" });
    expect(Date.parse(freshness.lastSuccessfulSyncAt!)).toBeLessThan(Date.parse(freshness.lastSyncAt!));
    expect(freshness.action).toMatch(/Reconnect the store/);
  });

  it("failing, never synced and stale are behind too; a 403 needs reconnecting, a 500 doesn't", () => {
    expect(syncFreshness({ ...healthy, failures: 1, lastError: "example-shop.myshopify.com said 500: oops" }, NOW, "Shopify")).toMatchObject({ behind: true, behindReason: "failing", needsReconnect: false });
    expect(syncFreshness({ ...healthy, lastSyncAt: null, lastSuccessfulSyncAt: null }, NOW, "Shopify")).toMatchObject({ behind: true, behindReason: "never_synced" });
    expect(syncFreshness({ ...healthy, lastSuccessfulSyncAt: "2026-11-04T04:00:00.000Z" }, NOW, "Shopify")).toMatchObject({ behind: true, behindReason: "stale" });
    expect(needsReconnect("active", "shop.example said 403: forbidden")).toBe(true);
    expect(needsReconnect("active", "shop.example said 500: oops")).toBe(false);
    expect(needsReconnect("disconnected", "shop.example said 401: no")).toBe(false);
    expect(syncFreshness({ ...refused, status: "disconnected" }, NOW, "Shopify")).toMatchObject({ behind: false, needsReconnect: false });
  });

  it("the store card says Reconnect prominently to admins, and the last success apart from the failed attempt", () => {
    const html = renderToStaticMarkup(
      createElement(ReconnectBanner, { connection: { platform: "shopify", status: "paused", needsReconnect: true, lastSuccessfulSyncAt: refused.lastSuccessfulSyncAt }, isAdmin: true, onReconnect: () => undefined }),
    );
    expect(html).toContain("Shopify no longer accepts Tohyee&#x27;s login.");
    expect(html).toMatch(/<button[^>]*>Reconnect<\/button>/);
    const viewer = renderToStaticMarkup(
      createElement(ReconnectBanner, { connection: { platform: "shopify", status: "paused", needsReconnect: true, lastSuccessfulSyncAt: null }, isAdmin: false, onReconnect: () => undefined }),
    );
    expect(viewer).toContain("Ask an admin to reconnect the store.");
    expect(viewer).not.toContain("<button");
    expect(renderToStaticMarkup(createElement(ReconnectBanner, { connection: { platform: "shopify", status: "active", needsReconnect: false, lastSuccessfulSyncAt: null }, isAdmin: true, onReconnect: () => undefined }))).toBe("");
    expect(lastSyncText(refused)).toMatch(/^Last synced .*\. Last tried .*, and it failed\.$/);
    expect(lastSyncText(healthy)).toMatch(/^Last synced [^.]*\.$/);
  });
});
