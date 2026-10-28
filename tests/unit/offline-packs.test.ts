import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { recordOnlineSignIn } from "@/lib/offline/device";
import { answerFromEntries, monthsBack, normaliseQuery, PACK_SECTIONS, type PackEntry } from "@/lib/offline/pack-inventory";
import { fileRefs, redact } from "@/lib/offline/pack-redact";
import { answerOffline, forgetPackMemory, offlineFile, type PackFetcher, readiness, refreshPacks, removePacks, setExtras } from "@/lib/offline/packs";
import { openQueue } from "@/lib/offline/queue";

/*
 * Offline farm packs (#472 stage 3, decisions 999-1007): answering screens'
 * reads from what's kept, keeping the last good copy, separation by
 * account and organisation, the 14-day lock, and what never goes in a
 * pack. Made-up data only.
 */

const SERVER = "https://farm.example.nz";
const SCOPE = { server: SERVER, userId: "user-1", organisationId: "org-1" };

describe("answering a read from what's kept", () => {
  const entries: PackEntry[] = [
    { path: "/api/farming/farms/f1/paddock-status", query: { onDate: "2026-10-01" }, body: { paddocks: [{ paddockId: "p1" }] } },
    { path: "/api/farming/safety", query: { farmId: "f1" }, body: { hazards: ["f1 hazard"] } },
    { path: "/api/farming/safety", query: { farmId: "f2" }, body: { hazards: ["f2 hazard"] } },
    { path: "/api/farming/farms/f1/grazings", query: { open: "1" }, body: { grazings: ["open"] } },
    { path: "/api/farming/farms/f1/grazings", query: { from: "2025-10-28", limit: "1000" }, body: { grazings: ["all"] } },
    {
      path: "/api/farming/calendar",
      query: { from: "2025-10-28", to: "2027-01-28", farmId: "f1" },
      body: { items: [{ date: "2026-10-27", title: "Old" }, { date: "2026-10-29", title: "Soon" }, { date: null, title: "Undated" }] },
    },
    { path: "/api/farm-notebook", query: {}, body: { notes: [{ title: "Water trough", body: "Fix the ballcock", category: "repairs" }, { title: "Rain", body: "12 mm", category: "weather" }] } },
  ];

  it("ignores day-to-day values (the date asked about, page sizes) and organisationId", () => {
    expect(answerFromEntries(entries, "/api/farming/farms/f1/paddock-status", { organisationId: "org-1", onDate: "2026-10-28" })).toEqual({ paddocks: [{ paddockId: "p1" }] });
    expect(answerFromEntries(entries, "/api/farming/farms/f1/grazings", { organisationId: "org-1", limit: 50 })).toEqual({ grazings: ["all"] });
    expect(answerFromEntries(entries, "/api/farming/farms/f1/grazings", { organisationId: "org-1", open: 1, version: 3 })).toEqual({ grazings: ["open"] });
  });

  it("keeps farms apart: another farm's answer is never given", () => {
    expect(answerFromEntries(entries, "/api/farming/safety", { farmId: "f2", includeWithdrawn: false })).toEqual({ hazards: ["f2 hazard"] });
    expect(answerFromEntries(entries, "/api/farming/safety", { farmId: "f3" })).toBeUndefined();
    expect(answerFromEntries(entries, "/api/farming/safety", { farmId: "f1", includeWithdrawn: true })).toBeUndefined();
  });

  it("narrows the calendar to the dates asked for, and searches the notebook within what's kept", () => {
    expect(answerFromEntries(entries, "/api/farming/calendar", { from: "2026-10-28", to: "2026-11-03", farmId: "f1" })).toEqual({ items: [{ date: "2026-10-29", title: "Soon" }, { date: null, title: "Undated" }] });
    expect(answerFromEntries(entries, "/api/farm-notebook", { search: "BALLCOCK" })).toEqual({ notes: [{ title: "Water trough", body: "Fix the ballcock", category: "repairs" }] });
    expect(answerFromEntries(entries, "/api/farm-notebook", { category: "weather" })).toEqual({ notes: [{ title: "Rain", body: "12 mm", category: "weather" }] });
  });

  it("reads queries as api() sends them, and dates back by months", () => {
    expect(normaliseQuery({ a: 1, b: null, c: "", d: undefined, e: false, f: true })).toEqual({ a: "1", f: "true" });
    expect(monthsBack("2026-10-28", 12)).toBe("2025-10-28");
  });
});

describe("what never goes in a pack", () => {
  it("takes out injury and medical details and restricted photos, even for an owner", () => {
    const body = {
      reports: [
        { recordId: "r1", details: { data: { injury: "Cut hand" } }, detailsHidden: false, files: [{ id: "a", sha256: "x", restricted: false }, { id: "b", sha256: "y", restricted: true }] },
        { recordId: "r2", details: null, detailsHidden: true, files: [] },
      ],
      access: { canSeeRestricted: true, isOwner: true },
    };
    const kept = redact("/api/farming/safety/reports", body) as typeof body;
    expect(kept.reports.map((report) => [report.details, report.detailsHidden, report.files.map((file) => file.id)])).toEqual([
      [null, true, ["a"]],
      [null, true, []],
    ]);
    expect(kept.access.canSeeRestricted).toBe(false);
    expect(JSON.stringify(kept)).not.toContain("Cut hand");
  });

  it("takes the email text out of calendar items made from mail, keeping the job", () => {
    const kept = redact("/api/farming/calendar", { items: [{ source: "email", title: "Spread urea", date: "2026-11-02", subject: "Your order", excerpt: "Dear Jess", senderEmail: "rep@example.com", senderName: "Rep", webLink: "https://mail.example.com/1" }, { source: "own", title: "Drench" }] }) as { items: Array<Record<string, unknown>> };
    expect(kept.items[0]).toMatchObject({ title: "Spread urea", date: "2026-11-02", subject: null, excerpt: null, senderEmail: null, senderName: null, webLink: null });
    expect(kept.items[1]).toEqual({ source: "own", title: "Drench" });
  });

  it("finds the files records name, never restricted ones", () => {
    const entries: PackEntry[] = [{ path: "/x", query: {}, body: { hazards: [{ data: { files: [{ id: "f1", name: "race.jpg", sha256: "1" }] } }], chemicals: [{ data: { sds: { id: "f2", name: "sds.pdf", sha256: "2" } } }], other: [{ id: "f3", sha256: "3", restricted: true }, { id: "no-hash" }] } }];
    expect(fileRefs(entries).map((file) => file.id)).toEqual(["f1", "f2"]);
  });
});

/** A pretend Tohyee: two farms, every section answering with one entry, and switches for failures. */
function pretendServer() {
  const state = { farms: [{ id: "f1", name: "Home" }, { id: "f2", name: "Runoff" }], down: false, refuse: new Set<string>(), calls: [] as string[], fileCalls: 0, version: 1 };
  const fetcher: PackFetcher = async (path, query) => {
    state.calls.push(`${path}?${new URLSearchParams(query)}`);
    if (state.down) return { status: 0, body: null };
    if (path === "/api/farming/offline-pack/file") {
      state.fileCalls += 1;
      return { status: 200, body: null, blob: new Blob([new Uint8Array(10)], { type: "image/jpeg" }), headers: new Headers({ "x-tohyee-copy": query.original ? "original" : "small" }) };
    }
    if (!query.section) return { status: 200, body: { farms: state.farms, sections: PACK_SECTIONS, months: 12 } };
    if (state.refuse.has(query.section)) return { status: 403, body: { error: "Not for your role." } };
    const farm = query.farmId ?? "_organisation";
    if (query.section === "photos") return { status: 200, body: { builtAt: "2026-10-28T00:00:00Z", months: 12, entries: [], skipped: [], files: [{ id: `photo-${farm}`, name: "race.jpg", contentType: "image/jpeg", sizeBytes: 5000000 }] } };
    const path2 = query.section === "safety" ? "/api/farming/safety" : `/api/test/${query.section}`;
    return { status: 200, body: { builtAt: "2026-10-28T00:00:00Z", months: Number(query.months ?? 12), entries: [{ path: path2, query: query.farmId ? { farmId: query.farmId } : {}, body: { farm, version: state.version } }], skipped: [] } };
  };
  return { state, fetcher };
}

async function setUp() {
  const factory = new IDBFactory();
  forgetPackMemory();
  await recordOnlineSignIn(SERVER, "user-1", new Date(), factory);
  return factory;
}

describe("keeping farms on the device", () => {
  it("keeps every farm's sections, then answers screens' reads from them", async () => {
    const factory = await setUp();
    const { fetcher, state } = pretendServer();
    const progress: number[] = [];
    const result = await refreshPacks(SCOPE, { fetcher, factory, locks: null, onProgress: (next) => progress.push(next.done) });
    expect(result).toEqual({ outcome: "done", updated: 2 + 9 * 2, failed: 0 });
    expect(progress.at(-1)).toBe(20);
    const rows = await readiness(SCOPE, factory);
    expect(rows.map((row) => [row.farmName, row.state])).toEqual([
      ["Organisation", "ready"],
      ["Home", "ready"],
      ["Runoff", "ready"],
    ]);
    const answer = await answerOffline(SCOPE, "/api/farming/safety", { organisationId: "org-1", farmId: "f2" }, { factory });
    expect(answer).toMatchObject({ found: true, body: { farm: "f2" }, section: "safety", farmId: "f2" });
    expect(await offlineFile(SCOPE, "photo-f1", factory)).toMatchObject({ id: "photo-f1", copy: "small" });
    // Kept within the last 15 minutes: nothing is fetched again.
    state.calls.length = 0;
    expect((await refreshPacks(SCOPE, { fetcher, factory, locks: null })).updated).toBe(0);
    expect(state.calls).toHaveLength(1);
  });

  it("keeps the last good copy when an update is refused or Tohyee can't be reached part way", async () => {
    const factory = await setUp();
    const { fetcher, state } = pretendServer();
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    state.version = 2;
    state.refuse.add("safety");
    const result = await refreshPacks(SCOPE, { fetcher, factory, locks: null, force: true });
    expect(result.failed).toBe(2);
    forgetPackMemory();
    expect(await answerOffline(SCOPE, "/api/farming/safety", { farmId: "f1" }, { factory })).toMatchObject({ found: true, body: { version: 1 } });
    const home = (await readiness(SCOPE, factory)).find((row) => row.farmId === "f1")!;
    expect(home.state).toBe("partial");
    expect(home.sections.find((section) => section.key === "safety")?.error).toBe("Not for your role.");

    state.refuse.clear();
    state.down = true;
    expect((await refreshPacks(SCOPE, { fetcher, factory, locks: null, force: true })).outcome).toBe("unreachable");
    forgetPackMemory();
    expect(await answerOffline(SCOPE, "/api/farming/safety", { farmId: "f1" }, { factory })).toMatchObject({ found: true, body: { version: 1 } });
  });

  it("fetches each photo once, and originals only on request", async () => {
    const factory = await setUp();
    const { fetcher, state } = pretendServer();
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    expect(state.fileCalls).toBe(2);
    await refreshPacks(SCOPE, { fetcher, factory, locks: null, force: true });
    expect(state.fileCalls).toBe(2);
    await setExtras(SCOPE, "f1", { originals: true, months: 36 }, factory);
    const before = state.calls.length;
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    const asked = state.calls.slice(before);
    expect(asked.filter((call) => call.includes("farmId=f1") && call.includes("months=36")).length).toBe(9);
    expect(asked.some((call) => call.includes("fileId=photo-f1") && call.includes("original=1"))).toBe(true);
    expect(asked.some((call) => call.includes("farmId=f2") && call.includes("section="))).toBe(false);
    expect(await offlineFile(SCOPE, "photo-f1", factory)).toMatchObject({ copy: "original" });
  });

  it("lets go of a farm the person can no longer see", async () => {
    const factory = await setUp();
    const { fetcher, state } = pretendServer();
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    state.farms = [{ id: "f1", name: "Home" }];
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    forgetPackMemory();
    expect((await readiness(SCOPE, factory)).map((row) => row.farmName)).toEqual(["Organisation", "Home"]);
    expect(await answerOffline(SCOPE, "/api/farming/safety", { farmId: "f2" }, { factory })).toEqual({ found: false, locked: false });
  });

  it("answers only the account and organisation it was kept for", async () => {
    const factory = await setUp();
    const { fetcher } = pretendServer();
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    expect((await answerOffline({ ...SCOPE, organisationId: "org-2" }, "/api/farming/safety", { farmId: "f1" }, { factory })).found).toBe(false);
    expect((await answerOffline({ ...SCOPE, userId: "user-2" }, "/api/farming/safety", { farmId: "f1" }, { factory })).found).toBe(false);
    // Another account can't build packs here until it signs in online.
    expect((await refreshPacks({ ...SCOPE, userId: "user-2" }, { fetcher, factory, locks: null })).outcome).toBe("locked");
  });

  it("locks what's kept 14 days after the last online sign-in", async () => {
    const factory = await setUp();
    const { fetcher } = pretendServer();
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    const later = new Date(Date.now() + 15 * 86_400_000);
    expect(await answerOffline(SCOPE, "/api/farming/safety", { farmId: "f1" }, { factory, now: later })).toEqual({ found: false, locked: true });
  });

  it("removes a farm's copy, never the work waiting to be sent", async () => {
    const factory = await setUp();
    const { fetcher } = pretendServer();
    await refreshPacks(SCOPE, { fetcher, factory, locks: null });
    const queue = await openQueue(SCOPE, { factory, locks: null, channel: false });
    await queue.add({ kind: "farm.reading", label: "Paddock 3", farmId: "f1", farmName: "Home", request: { method: "POST", path: "/api/x", body: {} } });
    await removePacks(SCOPE, "f1", factory);
    expect((await readiness(SCOPE, factory)).map((row) => row.farmName)).toEqual(["Organisation", "Runoff"]);
    await removePacks(SCOPE, null, factory);
    expect(await readiness(SCOPE, factory)).toEqual([]);
    expect((await openQueue(SCOPE, { factory, locks: null, channel: false })).unsentCount()).toBe(1);
  });

  it("stops quietly where Farming isn't used, and waits for sign-in on a 401", async () => {
    const factory = await setUp();
    expect((await refreshPacks(SCOPE, { fetcher: async () => ({ status: 403, body: { error: "Farming is off." } }), factory, locks: null })).outcome).toBe("not_farming");
    expect((await refreshPacks(SCOPE, { fetcher: async () => ({ status: 401, body: null }), factory, locks: null })).outcome).toBe("sign_in");
  });
});
