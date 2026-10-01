import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { describeSyncResult, SyncLog } from "@/components/sales-platforms";
import type { SyncLogEntry } from "@/lib/sales-platforms/types";

/** The sync log people read on Settings › Sales platforms (SPC2, SPC3, SPC10). */
describe("sales platform sync log", () => {
  const entry = (overrides: Partial<SyncLogEntry>): SyncLogEntry => ({
    id: "1",
    loggedAt: "2026-10-01T01:00:00.000Z",
    source: "sync",
    action: "created",
    recordKind: "customer",
    externalId: "1002",
    contactId: "5",
    itemId: null,
    message: "Added contact Tama Rewi from Shopify customer 1002.",
    actorEmail: "sales-platform-sync@tohyee",
    ...overrides,
  });

  it("shows what happened, why, and who did it", () => {
    const html = renderToStaticMarkup(
      createElement(SyncLog, {
        entries: [
          entry({ id: "3", action: "kept", message: "item CANDLE-L: Kept Tohyee's name \"Large soy candle\"" }),
          entry({ id: "2", action: "skipped", source: "webhook", message: "Shopify variant Wax melts - Lavender has no SKU" }),
          entry({ id: "1", action: "connected", source: "connection", actorEmail: "jess@glimmers.nz", message: "Connected Glimmers." }),
        ],
      }),
    );
    expect(html).toContain("Kept Tohyee&#x27;s value");
    expect(html).toContain("Large soy candle");
    expect(html).toContain("Skipped");
    expect(html).toContain("(webhook)");
    expect(html).toContain("jess@glimmers.nz");
    expect(html).toContain("Automatic");
  });

  it("says when nothing has happened yet", () => {
    expect(renderToStaticMarkup(createElement(SyncLog, { entries: [] }))).toContain("Nothing has happened yet.");
  });

  it("summarises a sync", () => {
    expect(describeSyncResult({ created: 1, linked: 1, updated: 0, kept: 0, skipped: 1, failed: 0 })).toBe(
      "Synced: 1 added, 1 linked, 0 updated, 1 skipped. The log below has the details.",
    );
  });
});
