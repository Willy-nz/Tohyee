import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { addressKind, clearOfflineCopies, forgetAccount, isIosSafari, offlineSession, platformOf, readDeviceAccount, recordOnlineSignIn } from "@/lib/offline/device";
import { openOfflineDb } from "@/lib/offline/idb";
import { openQueue } from "@/lib/offline/queue";

/*
 * Tohyee on this device (#472, decisions 990-994): the manifest, which
 * device and address this is, the service worker's rules, the 14-day
 * offline session, and one account's copies per device. Made-up data.
 */

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

type Rules = {
  OFFLINE_PAGES: string[];
  isOfflinePage(path: string): boolean;
  isStaticAsset(path: string): boolean;
  pageCacheName(origin: string, userId: string): string;
  isPageCache(name: string): boolean;
  sessionState(verifiedAt: string | null, now: number): { open: boolean; expiresAt: string | null };
  isSignedInPage(response: { status: number; url: string; headers: { get(name: string): string | null } }): boolean;
  assetUrlsFromHtml(html: string): string[];
  offlinePageHtml(kind: "offline" | "locked" | "none", saved: string[]): string;
};

function loadRules(): Rules {
  const code = fs.readFileSync(path.join(import.meta.dirname, "../../public/sw-rules.js"), "utf8");
  const sandbox: { self: { TohyeeSw?: Rules } } = { self: {} };
  vm.runInNewContext(code, sandbox);
  return sandbox.self.TohyeeSw!;
}

describe("the manifest", () => {
  it("opens this server's Tohyee in its own window, with icons that exist", () => {
    const value = manifest();
    expect(value).toMatchObject({ name: "Tohyee", short_name: "Tohyee", start_url: "/", scope: "/", display: "standalone", id: "/" });
    const icons = value.icons ?? [];
    expect(icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of icons) expect(fs.existsSync(path.join(import.meta.dirname, "../../public", icon.src))).toBe(true);
    expect(fs.existsSync(path.join(import.meta.dirname, "../../src/app/apple-icon.png"))).toBe(true);
  });
});

describe("which device", () => {
  it("tells iPhone, iPad (which says it's a Mac but has touch), Android and computers apart", () => {
    expect(platformOf(IPHONE)).toBe("iphone");
    expect(platformOf(IPAD, 5)).toBe("ipad");
    expect(platformOf(IPAD, 0)).toBe("desktop");
    expect(platformOf(ANDROID)).toBe("android");
    expect(platformOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0")).toBe("desktop");
  });

  it("knows Safari from other iPhone browsers", () => {
    expect(isIosSafari(IPHONE)).toBe(true);
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
  });
});

describe("which address", () => {
  it("allows HTTPS and this computer, and explains home-network and Tailscale addresses without HTTPS", () => {
    expect(addressKind("https://farm.example.nz/get-tohyee", true)).toBe("secure");
    expect(addressKind("http://localhost:3000/get-tohyee", true)).toBe("secure");
    expect(addressKind("http://192.168.1.20:3000/", false)).toBe("lan");
    expect(addressKind("http://10.0.0.5/", false)).toBe("lan");
    expect(addressKind("http://172.20.1.1/", false)).toBe("lan");
    expect(addressKind("http://tohyee-server.local/", false)).toBe("lan");
    expect(addressKind("http://tohyee/", false)).toBe("lan");
    expect(addressKind("http://100.101.102.103:3000/", false)).toBe("tailscale");
    expect(addressKind("http://tohyee.tail1234.ts.net/", false)).toBe("tailscale");
    expect(addressKind("http://farm.example.nz/", false)).toBe("insecure");
  });
});

describe("the offline session", () => {
  it("opens the device's copies for 14 days after the last online sign-in, then locks them", () => {
    const account = { verifiedAt: "2026-10-01T08:00:00.000Z" };
    expect(offlineSession(account, new Date("2026-10-15T07:59:59.000Z"))).toEqual({ open: true, expiresAt: "2026-10-15T08:00:00.000Z" });
    expect(offlineSession(account, new Date("2026-10-15T08:00:00.000Z")).open).toBe(false);
    expect(offlineSession(null, new Date()).open).toBe(false);
    // The service worker applies the same rule.
    const rules = loadRules();
    expect(rules.sessionState("2026-10-01T08:00:00.000Z", Date.parse("2026-10-15T07:59:59.000Z"))).toEqual({ open: true, expiresAt: "2026-10-15T08:00:00.000Z" });
    expect(rules.sessionState("2026-10-01T08:00:00.000Z", Date.parse("2026-10-16T00:00:00.000Z")).open).toBe(false);
    expect(rules.sessionState(null, Date.now()).open).toBe(false);
  });
});

describe("the service worker's rules", () => {
  const rules = loadRules();

  it("keeps only the farm pages and the install page for offline use", () => {
    expect(rules.isOfflinePage("/operations/farm")).toBe(true);
    expect(rules.isOfflinePage("/operations/farm/safety/")).toBe(true);
    expect(rules.isOfflinePage("/get-tohyee")).toBe(true);
    expect(rules.isOfflinePage("/operations")).toBe(false);
    expect(rules.isOfflinePage("/operations/invoices")).toBe(false);
    expect(rules.isOfflinePage("/operations/farming/pasture")).toBe(false);
    expect(rules.isStaticAsset("/_next/static/chunks/app.js")).toBe(true);
    expect(rules.isStaticAsset("/icons/tohyee-192.png")).toBe(true);
    expect(rules.isStaticAsset("/api/farming/farms")).toBe(false);
  });

  it("names page caches by server and account, without spelling them out", () => {
    const a = rules.pageCacheName("https://farm.example.nz", "user-1");
    expect(a).toMatch(/^tohyee-pages-[0-9a-f]{8}$/);
    expect(a).not.toContain("user-1");
    expect(rules.pageCacheName("https://farm.example.nz", "user-2")).not.toBe(a);
    expect(rules.pageCacheName("https://other.example.nz", "user-1")).not.toBe(a);
    expect(rules.isPageCache(a)).toBe(true);
    expect(rules.isPageCache("tohyee-static-v1")).toBe(false);
  });

  it("keeps a page only when it's a signed-in page, never the sign-in page it was sent to", () => {
    const html = { get: () => "text/html; charset=utf-8" };
    expect(rules.isSignedInPage({ status: 200, url: "https://farm.example.nz/operations/farm", headers: html })).toBe(true);
    expect(rules.isSignedInPage({ status: 200, url: "https://farm.example.nz/login?next=%2Foperations%2Ffarm", headers: html })).toBe(false);
    expect(rules.isSignedInPage({ status: 500, url: "https://farm.example.nz/operations/farm", headers: html })).toBe(false);
    expect(rules.isSignedInPage({ status: 200, url: "https://farm.example.nz/operations/farm", headers: { get: () => "application/json" } })).toBe(false);
  });

  it("finds the built files a page loads", () => {
    const html = '<script src="/_next/static/chunks/a-1.js" async></script><link rel="stylesheet" href="/_next/static/css/b.css"/>"/_next/static/chunks/a-1.js" /_next/static/media/inter.woff2';
    expect(rules.assetUrlsFromHtml(html)).toEqual(["/_next/static/chunks/a-1.js", "/_next/static/css/b.css", "/_next/static/media/inter.woff2"]);
  });

  it("explains being offline, locked and never signed in, and escapes what it shows", () => {
    expect(rules.offlinePageHtml("offline", ["/operations/farm", "/get-tohyee"])).toContain('<a href="/operations/farm">Today</a>');
    expect(rules.offlinePageHtml("locked", [])).toContain("more than 14 days");
    expect(rules.offlinePageHtml("none", [])).toContain("needs a connection the first time");
    expect(rules.offlinePageHtml("offline", ['/x"><script>'])).not.toContain("<script>");
  });
});

describe("one account's copies per device", () => {
  async function addPack(factory: IDBFactory, scope: string, id: string) {
    const db = await openOfflineDb(factory);
    await db.write(["packs", "packSections"], (tx) => {
      tx.objectStore("packs").put({ id, scope });
      tx.objectStore("packSections").put({ id: `${id}|paddocks`, packId: id, scope });
    });
  }

  it("deletes another account's farm information (not its unsent work) when someone else signs in", async () => {
    const factory = new IDBFactory();
    const server = "https://farm.example.nz";
    await recordOnlineSignIn(server, "user-1", new Date("2026-10-28T08:00:00Z"), factory);
    await addPack(factory, `${encodeURIComponent(server)}|user-1|org-1`, "p1");
    const queue = await openQueue({ server, userId: "user-1", organisationId: "org-1" }, { factory, locks: null, channel: false });
    await queue.add({ kind: "farm.reading", label: "Paddock 3", farmId: "f", farmName: "F", request: { method: "POST", path: "/api/x", body: {} } });

    expect(await recordOnlineSignIn(server, "user-2", new Date("2026-10-28T09:00:00Z"), factory)).toEqual({ replaced: true });
    const db = await openOfflineDb(factory);
    expect(await db.all("packs")).toEqual([]);
    expect(await db.all("packSections")).toEqual([]);
    expect((await db.all("queue")).length).toBe(1);
    expect(await readDeviceAccount(factory)).toMatchObject({ userId: "user-2", verifiedAt: "2026-10-28T09:00:00.000Z" });
  });

  it("keeps the same account's copies when it signs in again, and forgets them at sign-out", async () => {
    const factory = new IDBFactory();
    const server = "https://farm.example.nz";
    await recordOnlineSignIn(server, "user-1", new Date("2026-10-28T08:00:00Z"), factory);
    await addPack(factory, `${encodeURIComponent(server)}|user-1|org-1`, "p1");
    expect(await recordOnlineSignIn(server, "user-1", new Date("2026-10-28T10:00:00Z"), factory)).toEqual({ replaced: false });
    const db = await openOfflineDb(factory);
    expect((await db.all("packs")).length).toBe(1);
    await forgetAccount(server, "user-1", factory);
    expect(await db.all("packs")).toEqual([]);
    expect(await readDeviceAccount(factory)).toBeNull();
  });

  it("can keep one account's copies and clear the rest", async () => {
    const factory = new IDBFactory();
    const server = "https://farm.example.nz";
    await addPack(factory, `${encodeURIComponent(server)}|user-1|org-1`, "keep");
    await addPack(factory, `${encodeURIComponent(server)}|user-2|org-1`, "drop");
    await clearOfflineCopies(server, "user-1", factory);
    const db = await openOfflineDb(factory);
    expect((await db.all<{ id: string }>("packs")).map((pack) => pack.id)).toEqual(["keep"]);
  });
});
