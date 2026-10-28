import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { sessionCheck } from "@/lib/offline/account";
import { OFFLINE_SCREENS, screensMissing } from "@/lib/offline/screens";

/*
 * The real service worker (public/sw.js with public/sw-rules.js), run in a
 * sandbox with a pretend browser: its caches, its IndexedDB
 * (fake-indexeddb), a clock and Tohyee answering (or not). Checks that
 * the farm sections' screens open with no connection after one online
 * sign-in, without visiting each (#477, decision 1056), and that only
 * Tohyee saying this same account is signed in renews the 14-day offline
 * session (#481, decision 1052). Made-up data only.
 */

const ORIGIN = "https://farm.example.nz";
const DAY = 86_400_000;
const code = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "../../public", file), "utf8");

type Answer = { status: number; body?: unknown } | "offline";

function pretendBrowser() {
  let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [string]));
      else super(nowMs);
    }
    static now() {
      return nowMs;
    }
  }
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (input: unknown) => {
    const url = new URL(typeof input === "string" ? input : (input as { url: string }).url, ORIGIN);
    return url.pathname + url.search;
  };
  const cache = (store: Map<string, Response>) => ({
    async put(input: unknown, response: Response) {
      store.set(keyOf(input), response);
    },
    async match(input: unknown, options?: { ignoreSearch?: boolean }) {
      const key = keyOf(input);
      let hit = store.get(key);
      if (!hit && options?.ignoreSearch) for (const [other, value] of store) if (other.split("?")[0] === key.split("?")[0]) hit = value;
      return hit ? hit.clone() : undefined;
    },
    async keys() {
      return [...store.keys()].map((key) => ({ url: ORIGIN + key }));
    },
    async delete(input: unknown) {
      return store.delete(keyOf(input));
    },
  });
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(stores.get(name)!);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  let online = true;
  let session: Answer = { status: 401, body: { error: "Please sign in." } };
  const fetched: string[] = [];
  const fetchFake = async (input: unknown) => {
    const where = keyOf(input);
    if (!online) throw new TypeError("Failed to fetch");
    fetched.push(where);
    if (where === "/api/auth/session") {
      if (session === "offline") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(session.body ?? null), { status: session.status, headers: { "content-type": "application/json" } });
    }
    if (where.startsWith("/_next/static/")) return new Response("/* built */", { headers: { "content-type": "application/javascript" } });
    const page = where.split("?")[0];
    return new Response(`<!doctype html><html><body data-page="${page}"><script src="/_next/static/chunks${page.replace(/\//g, "-")}.js"></script></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const sandbox: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    location: { origin: ORIGIN },
    caches,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    fetch: fetchFake,
    Response,
    URL,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = () => vm.runInContext(code("sw-rules.js"), context);
  vm.runInContext(code("sw.js"), context);

  async function message<T>(data: Record<string, unknown>): Promise<T> {
    let reply: unknown = null;
    const waits: Promise<unknown>[] = [];
    listeners.get("message")!({ data, ports: [{ postMessage: (value: unknown) => (reply = value) }], waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
    return reply as T;
  }

  async function navigate(path: string): Promise<{ status: number; html: string }> {
    let answer: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    listeners.get("fetch")!({ request: { method: "GET", url: ORIGIN + path, mode: "navigate" }, respondWith: (promise: Promise<Response>) => (answer = promise), waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    const response = await answer!;
    await Promise.all(waits);
    return { status: response.status, html: await response.text() };
  }

  type Status = { context: { userId: string; verifiedAt: string | null } | null; pages: string[]; session: { open: boolean } | null };
  return {
    message,
    navigate,
    status: () => message<Status>({ type: "status" }),
    setOnline: (value: boolean) => (online = value),
    setSession: (value: Answer) => (session = value),
    advance: (ms: number) => (nowMs += ms),
    now: () => new RealDate(nowMs).toISOString(),
    fetched,
  };
}

const signedIn = (id: string) => ({ status: 200, body: { user: { id, email: `${id}@example.com` }, organisations: [] } });

describe("the farm sections open with no connection (#477)", () => {
  it("lists the same screens in the worker and the page", () => {
    const sandbox: { self: { TohyeeSw?: { OFFLINE_PAGES: string[] } } } = { self: {} };
    vm.runInNewContext(code("sw-rules.js"), sandbox);
    expect(sandbox.self.TohyeeSw!.OFFLINE_PAGES).toEqual([...OFFLINE_SCREENS.map((screen) => screen.path), "/get-tohyee"]);
    expect(OFFLINE_SCREENS.map((screen) => screen.path)).toEqual(expect.arrayContaining(["/operations/farming/pasture", "/operations/farming/soil", "/operations/farming/calendar", "/operations/farming/fertiliser", "/operations/farming/notebook", "/operations/farm/tractor"]));
  });

  it("saves every screen after one online sign-in, then opens each with no connection, its built files kept", async () => {
    const browser = pretendBrowser();
    browser.setSession(signedIn("user-a"));
    expect(await browser.message({ type: "context", userId: "user-a", organisationId: "org-1", online: true })).toEqual({ ok: true });
    const status = await browser.status();
    expect(screensMissing(status.pages)).toEqual([]);

    browser.setOnline(false);
    for (const screen of ["/operations/farming/soil", "/operations/farming/fertiliser", "/operations/farming/calendar", "/operations/farming/notebook", "/operations/farming/pasture", "/operations/farming", "/operations/farm/tractor"]) {
      const opened = await browser.navigate(`${screen}?farm=12`);
      expect(opened.status, screen).toBe(200);
      expect(opened.html).toContain(`data-page="${screen}"`);
    }
    // A page never saved still says it needs a connection.
    expect((await browser.navigate("/operations/farming/benchmarks")).html).toContain("<h1>You&#39;re offline</h1>");
  });

  it("says which screens aren't saved yet", () => {
    expect(screensMissing(["/operations/farm", "/operations/farm/map/"]).map((screen) => screen.name)).not.toContain("Map");
    expect(screensMissing([]).length).toBe(OFFLINE_SCREENS.length);
  });
});

describe("only Tohyee confirming the same account renews the offline session (#481)", () => {
  it("checks the session's account, not just that it answered", () => {
    expect(sessionCheck(200, { user: { id: "a" } }, "a")).toBe("verified");
    expect(sessionCheck(200, { user: { id: "b" } }, "a")).toBe("other_account");
    expect(sessionCheck(401, { error: "Please sign in." }, "a")).toBe("signed_out");
    expect(sessionCheck(200, "<html>", "a")).toBe("unreachable");
    expect(sessionCheck(null, null, "a")).toBe("unreachable");
  });

  it("isn't renewed by the public install page, a 401, another account or no connection; is by the same account", async () => {
    const browser = pretendBrowser();
    browser.setSession(signedIn("user-a"));
    await browser.message({ type: "context", userId: "user-a", online: true });
    const first = (await browser.status()).context!.verifiedAt;
    expect(first).toBe(browser.now());

    // Thirteen days on, the server session has been revoked; the device's copies are still kept.
    browser.advance(13 * DAY);
    browser.setSession({ status: 401, body: { error: "Please sign in." } });
    expect((await browser.navigate("/get-tohyee")).status).toBe(200);
    expect((await browser.navigate("/operations/farm")).status).toBe(200);
    expect((await browser.status()).context!.verifiedAt).toBe(first);

    await browser.message({ type: "context", userId: "user-a", online: true });
    expect((await browser.status()).context!.verifiedAt).toBe(first);

    browser.setSession(signedIn("user-b"));
    expect(await browser.message({ type: "context", userId: "user-a", online: true })).toEqual({ ok: false, reason: "other_account" });
    expect((await browser.status()).context).toMatchObject({ userId: "user-a", verifiedAt: first });

    browser.setSession("offline");
    await browser.message({ type: "context", userId: "user-a", online: true });
    expect((await browser.status()).context!.verifiedAt).toBe(first);

    // A day later still, it's locked: the copies don't open.
    browser.advance(2 * DAY);
    browser.setOnline(false);
    expect((await browser.navigate("/operations/farm")).html).toContain("<h1>Sign in to open Tohyee&#39;s offline copies</h1>");

    // Signing in online as the same account renews it.
    browser.setOnline(true);
    browser.setSession(signedIn("user-a"));
    await browser.message({ type: "context", userId: "user-a", online: true });
    expect((await browser.status()).context!.verifiedAt).toBe(browser.now());
  });
});
