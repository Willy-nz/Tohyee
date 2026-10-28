import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_CHANGED_CODE, EXPECTED_ACCOUNT_HEADER } from "@/lib/offline/account";
import { recordOnlineSignIn } from "@/lib/offline/device";
import { fetchPackFetcher, readiness, refreshPacks } from "@/lib/offline/packs";
import { fetchSender, heldForOtherAccounts, holdSending, openQueue } from "@/lib/offline/queue";

/*
 * Offline work stays with the account that made it (#478, decisions
 * 1050-1051). A browser shares one sign-in between tabs: these tests use a
 * pretend Tohyee that answers as whoever the cookie says, and refuses a
 * request naming a different account, as src/lib/auth/guard.ts does.
 * Made-up data only.
 */

const SERVER = "https://farm.example.nz";

function pretendTohyee() {
  const state = { signedIn: "user-a" as string | null, recorded: [] as Array<{ path: string; as: string; operationId: unknown }>, beforeEach: null as null | ((path: string) => void) };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), SERVER);
    state.beforeEach?.(url.pathname);
    const headers = new Headers(init?.headers);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!state.signedIn) return json(401, { error: "Please sign in.", code: "unauthorized" });
    const expected = headers.get(EXPECTED_ACCOUNT_HEADER);
    if (expected !== null && expected !== state.signedIn) return json(401, { error: "Signed in as someone else.", code: ACCOUNT_CHANGED_CODE });
    if ((init?.method ?? "GET") === "GET") {
      if (url.pathname === "/api/farming/offline-pack" && !url.searchParams.get("section")) return json(200, { farms: [{ id: "f1", name: "Home farm" }], sections: [{ key: "safety", label: "Safety", includes: "", perFarm: true }] });
      return json(200, { builtAt: "2026-10-28T00:00:00.000Z", months: 12, entries: [{ path: "/api/farming/safety", query: { farmId: "f1" }, body: { hazards: [`${state.signedIn}'s hazards`] } }], skipped: [] });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { operationId?: unknown };
    state.recorded.push({ path: url.pathname, as: state.signedIn, operationId: body.operationId });
    return json(201, { ok: true });
  }) as typeof fetch;
  return { state, fetcher };
}

const work = [
  { kind: "safety.report", label: "Near miss on the race", path: "/api/farming/safety/reports" },
  { kind: "safety.check", label: "Pre-start: quad", path: "/api/farming/safety/checks" },
  { kind: "safety.signoff", label: "Induction signed", path: "/api/farming/safety/signoffs" },
];

async function queueWithWork(factory: IDBFactory) {
  const queue = await openQueue({ server: SERVER, userId: "user-a", organisationId: "org-1" }, { factory, locks: null, channel: false });
  for (const item of work) await queue.add({ kind: item.kind, label: item.label, farmId: "f1", farmName: "Home farm", request: { method: "POST", path: item.path, body: { farmId: "f1" } } });
  return queue;
}

afterEach(() => holdSending(false));

describe("queued work and a different signed-in account", () => {
  it("isn't sent as B: A's report, pre-start and sign-off stay waiting for A, then go as A", async () => {
    const factory = new IDBFactory();
    const tohyee = pretendTohyee();
    const queue = await queueWithWork(factory);

    // Another tab signs out and signs in as B; A's old tab tries to send.
    tohyee.state.signedIn = "user-b";
    expect((await queue.sync(fetchSender(tohyee.fetcher))).stoppedBecause).toBe("account_changed");
    expect(tohyee.state.recorded).toEqual([]);
    expect(queue.items().map((item) => [item.status, item.error])).toEqual([
      ["waiting", null],
      ["waiting", null],
      ["waiting", null],
    ]);

    // B's queue never has A's work; B is told some is held for someone else.
    const asB = await openQueue({ server: SERVER, userId: "user-b", organisationId: "org-1" }, { factory, locks: null, channel: false });
    expect(asB.items()).toEqual([]);
    expect(await heldForOtherAccounts(SERVER, "user-b", factory)).toBe(3);
    expect(await heldForOtherAccounts(SERVER, "user-a", factory)).toBe(0);

    // A signs in again: it all goes, as A, once each.
    tohyee.state.signedIn = "user-a";
    expect(await queue.sync(fetchSender(tohyee.fetcher))).toEqual({ sent: 3, refused: 0, stoppedBecause: "done" });
    expect(tohyee.state.recorded.map((entry) => entry.as)).toEqual(["user-a", "user-a", "user-a"]);
    expect(await heldForOtherAccounts(SERVER, "user-b", factory)).toBe(0);
  });

  it("stops when the account changes part way through, between one send and the next", async () => {
    const factory = new IDBFactory();
    const tohyee = pretendTohyee();
    const queue = await queueWithWork(factory);
    let sends = 0;
    tohyee.state.beforeEach = () => {
      sends += 1;
      if (sends === 2) tohyee.state.signedIn = "user-b";
    };
    expect(await queue.sync(fetchSender(tohyee.fetcher))).toEqual({ sent: 1, refused: 0, stoppedBecause: "account_changed" });
    const synced = queue.items().filter((item) => item.status === "synced");
    expect(synced).toHaveLength(1);
    expect(tohyee.state.recorded).toEqual([{ path: synced[0].request.path, as: "user-a", operationId: synced[0].operationId }]);
    expect(queue.items().filter((item) => item.status === "waiting")).toHaveLength(2);
  });

  it("sends nothing while this tab is held", async () => {
    const factory = new IDBFactory();
    const tohyee = pretendTohyee();
    const queue = await queueWithWork(factory);
    holdSending(true);
    expect((await queue.sync(fetchSender(tohyee.fetcher))).stoppedBecause).toBe("held");
    expect(tohyee.state.recorded).toEqual([]);
  });
});

describe("farm packs and a different signed-in account", () => {
  it("never keeps B's answers as A's, and says the account changed", async () => {
    const factory = new IDBFactory();
    const tohyee = pretendTohyee();
    const scope = { server: SERVER, userId: "user-a", organisationId: "org-1" };
    await recordOnlineSignIn(SERVER, "user-a", new Date("2026-10-28T00:00:00Z"), factory);
    tohyee.state.signedIn = "user-b";
    const result = await refreshPacks(scope, { factory, locks: null, fetcher: fetchPackFetcher(tohyee.fetcher, "user-a") });
    expect(result.outcome).toBe("account_changed");
    expect(await readiness(scope, factory)).toEqual([]);
  });

  it("stops between sections when asked to", async () => {
    const factory = new IDBFactory();
    const tohyee = pretendTohyee();
    const scope = { server: SERVER, userId: "user-a", organisationId: "org-1" };
    await recordOnlineSignIn(SERVER, "user-a", new Date("2026-10-28T00:00:00Z"), factory);
    const result = await refreshPacks(scope, { factory, locks: null, fetcher: fetchPackFetcher(tohyee.fetcher, "user-a"), shouldStop: () => true });
    expect(result).toEqual({ outcome: "stopped", updated: 0, failed: 0 });
  });
});
