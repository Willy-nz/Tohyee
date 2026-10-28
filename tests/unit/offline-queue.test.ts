import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openOfflineDb } from "@/lib/offline/idb";
import { blockedBy, bodyToSend, itemsToPrune, newOperationId, openQueue, type QueueItem, type Sender, scopeKey, sendOutcome, unsentForAccount } from "@/lib/offline/queue";

/*
 * The device's queue (#472, decisions 995-998): stable operation ids,
 * honest statuses, sending once, refusals kept for a person, files and
 * earlier results put into later requests, and separation by server,
 * account and organisation. Made-up data only.
 */

const SCOPE = { server: "https://farm.example.nz", userId: "user-1", organisationId: "org-1" };

function clock(start = "2026-10-28T09:00:00.000Z") {
  let time = Date.parse(start);
  return () => new Date((time += 1000)).toISOString();
}

async function fresh(scope = SCOPE, factory = new IDBFactory(), now = clock()) {
  return { factory, queue: await openQueue(scope, { factory, now, locks: null, channel: false }) };
}

function reportItem(label = "Near miss: tractor on the race") {
  return { kind: "safety.report", label, farmId: "farm-a", farmName: "Farm A", request: { method: "POST" as const, path: "/api/farming/safety/reports", body: { farmId: "farm-a", kind: "near_miss", what: "Tractor on the race" } } };
}

/** A pretend server that records each body and answers by operation id, like Tohyee's (decision 912). */
function server(answer: (body: Record<string, unknown>, item: QueueItem) => ReturnType<Sender> = async (body) => ({ outcome: "done", result: { id: `rec-${String(body.operationId).slice(0, 4)}` } })) {
  const seen: Array<Record<string, unknown>> = [];
  const send: Sender = async (item, body) => {
    seen.push(body);
    return answer(body, item);
  };
  return { seen, send };
}

describe("operation ids", () => {
  it("are version 4 UUIDs", () => {
    expect(newOperationId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newOperationId()).not.toBe(newOperationId());
  });
});

describe("the queue", () => {
  it("keeps an item on the device as Waiting to send, and it survives reopening", async () => {
    const factory = new IDBFactory();
    const { queue } = await fresh(SCOPE, factory);
    const { item, stored } = await queue.add(reportItem());
    expect(stored).toBe(true);
    expect(queue.shownStatus(item)).toBe("waiting");
    const again = await openQueue(SCOPE, { factory, locks: null, channel: false });
    expect(again.items().map((entry) => [entry.operationId, entry.status])).toEqual([[item.operationId, "waiting"]]);
  });

  it("sends once, with organisationId and its operation id, and a second sync sends nothing", async () => {
    const { queue } = await fresh();
    const { item } = await queue.add(reportItem());
    const remote = server();
    expect(await queue.sync(remote.send)).toEqual({ sent: 1, refused: 0, stoppedBecause: "done" });
    expect(await queue.sync(remote.send)).toEqual({ sent: 0, refused: 0, stoppedBecause: "done" });
    expect(remote.seen).toEqual([{ farmId: "farm-a", kind: "near_miss", what: "Tractor on the race", organisationId: "org-1", operationId: item.operationId }]);
    const [synced] = queue.items();
    expect(synced.status).toBe("synced");
    expect(synced.result).toEqual({ id: `rec-${item.operationId.slice(0, 4)}` });
  });

  it("stops at the first item that can't reach Tohyee, keeping it and everything after it waiting", async () => {
    const { queue } = await fresh();
    await queue.add(reportItem("First"));
    await queue.add(reportItem("Second"));
    const remote = server(async () => ({ outcome: "unreachable" }));
    expect(await queue.sync(remote.send)).toEqual({ sent: 0, refused: 0, stoppedBecause: "unreachable" });
    expect(remote.seen).toHaveLength(1);
    expect(queue.items().map((item) => [item.label, item.status, item.attempts])).toEqual([
      ["First", "waiting", 1],
      ["Second", "waiting", 0],
    ]);
    // The same operation id goes again next time, so the server finds the first if it did arrive.
    const again = server();
    await queue.sync(again.send);
    expect(again.seen.map((body) => body.operationId)).toEqual(queue.items().map((item) => item.operationId));
  });

  it("says sign in is needed on a 401, and keeps the item", async () => {
    expect(sendOutcome(401, "Sign in")).toEqual({ outcome: "unreachable", signIn: true });
    const { queue } = await fresh();
    await queue.add(reportItem());
    expect((await queue.sync(async () => sendOutcome(401, "Sign in"))).stoppedBecause).toBe("sign_in");
    expect(queue.items()[0].status).toBe("waiting");
  });

  it("marks a refusal (a version conflict) Needs attention with Tohyee's reason, never sends it again by itself, and goes on to the next", async () => {
    const { queue } = await fresh();
    await queue.add({ ...reportItem("Closed action"), request: { method: "POST", path: "/api/farming/safety/actions/a1", body: { step: "done", expectedVersion: 2 } } });
    await queue.add(reportItem("Hazard"));
    const remote = server(async (body) => (body.expectedVersion === 2 ? sendOutcome(409, "Someone saved this since you opened it. Reload to see their change.") : { outcome: "done", result: {} }));
    expect(await queue.sync(remote.send)).toEqual({ sent: 1, refused: 1, stoppedBecause: "done" });
    const [conflict, hazard] = queue.items();
    expect([conflict.status, conflict.error]).toEqual(["attention", "Someone saved this since you opened it. Reload to see their change."]);
    expect(queue.shownStatus(conflict)).toBe("attention");
    expect(hazard.status).toBe("synced");
    await queue.sync(remote.send);
    expect(remote.seen).toHaveLength(2);
  });

  it("treats timeouts, rate limits and server errors as try-again, and other 4xx as refusals", () => {
    expect(sendOutcome(408, "x").outcome).toBe("unreachable");
    expect(sendOutcome(429, "x").outcome).toBe("unreachable");
    expect(sendOutcome(503, "x").outcome).toBe("unreachable");
    expect(sendOutcome(null, "x").outcome).toBe("unreachable");
    expect(sendOutcome(400, "x").outcome).toBe("refused");
    expect(sendOutcome(403, "x").outcome).toBe("refused");
    expect(sendOutcome(409, "x").outcome).toBe("refused");
  });

  it("lets an item never sent be changed, but not once a send was tried", async () => {
    const { queue } = await fresh();
    const { item } = await queue.add({ ...reportItem(), ready: false });
    expect(queue.shownStatus(item)).toBe("saved");
    await queue.change(item.operationId, { body: { farmId: "farm-a", kind: "near_miss", what: "Quad on the race" } });
    await queue.markReady(item.operationId);
    expect(queue.items()[0].status).toBe("waiting");
    await queue.sync(async () => ({ outcome: "unreachable" }));
    await expect(queue.change(item.operationId, { label: "Other" })).rejects.toThrow(/new one/);
  });

  it("doesn't send items still Saved on this device (not ready)", async () => {
    const { queue } = await fresh();
    await queue.add({ ...reportItem(), ready: false });
    const remote = server();
    await queue.sync(remote.send);
    expect(remote.seen).toHaveLength(0);
  });

  it("sends what the item is now: a change made while another item was being sent is kept", async () => {
    const { queue } = await fresh();
    await queue.add(reportItem("First"));
    const { item: second } = await queue.add({ ...reportItem("Second"), ready: false });
    const remote = server(async (body) => {
      // While the first is on its way, the second is changed and made ready.
      if (body.operationId !== second.operationId) await queue.change(second.operationId, { label: "Second, changed", ready: true });
      return { outcome: "done", result: {} };
    });
    await queue.sync(remote.send);
    expect(queue.items().map((item) => [item.label, item.status])).toEqual([
      ["First", "synced"],
      ["Second, changed", "synced"],
    ]);
  });

  it("puts a photo in the request when it's sent, and a later report waits for the photo's id", async () => {
    const { queue } = await fresh();
    const { item: photo } = await queue.add({
      kind: "safety.photo",
      label: "Photo",
      farmId: "farm-a",
      farmName: "Farm A",
      request: { method: "POST", path: "/api/farming/safety/files", body: { farmId: "farm-a", fileName: "race.jpg", contentType: "image/jpeg" }, files: [{ blob: "photo", field: "contentBase64" }] },
      blobs: { photo: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x01])], { type: "image/jpeg" }) },
    });
    const { item: report } = await queue.add({ ...reportItem(), request: { ...reportItem().request, body: { farmId: "farm-a", files: [{ id: null }] }, refs: [{ path: ["files", "0", "id"], from: photo.operationId, field: ["file", "id"] }] } });
    expect(blockedBy(report, queue.items())).toMatchObject({ operationId: photo.operationId });
    expect(await queue.blob(photo.operationId, "photo")).not.toBeNull();

    // The photo can't go: the report waits behind it.
    const offline = server(async () => ({ outcome: "unreachable" }));
    await queue.sync(offline.send);
    expect(offline.seen).toHaveLength(1);

    const remote = server(async (body) => (body.contentBase64 ? { outcome: "done", result: { file: { id: "file-9" } } } : { outcome: "done", result: { report: { id: "r1" } } }));
    expect((await queue.sync(remote.send)).sent).toBe(2);
    expect(remote.seen[0].contentBase64).toBe("/9j/AQ==");
    expect(remote.seen[1].files).toEqual([{ id: "file-9" }]);
    // The photo's copy goes from the device once Tohyee has it.
    expect(await queue.blob(photo.operationId, "photo")).toBeNull();
  });

  it("keeps a report waiting while its photo needs attention", async () => {
    const { queue } = await fresh();
    const { item: photo } = await queue.add({ kind: "safety.photo", label: "Photo", farmId: "farm-a", farmName: "Farm A", request: { method: "POST", path: "/api/farming/safety/files", body: {} } });
    await queue.add({ ...reportItem(), request: { ...reportItem().request, refs: [{ path: ["files", "0", "id"], from: photo.operationId, field: ["file", "id"] }] } });
    const remote = server(async (body) => (body.operationId === photo.operationId ? sendOutcome(400, "That isn't a photo.") : { outcome: "done", result: {} }));
    await queue.sync(remote.send);
    expect(queue.items().map((item) => item.status)).toEqual(["attention", "waiting"]);
    expect(remote.seen).toHaveLength(1);
  });

  it("refuses approvals: they always need Tohyee", async () => {
    const { queue } = await fresh();
    await expect(queue.add({ ...reportItem(), kind: "safety.release" })).rejects.toThrow(/approvals are never saved/);
  });

  it("lets go of refused or synced items only, never one still waiting", async () => {
    const { queue } = await fresh();
    const { item } = await queue.add(reportItem());
    await expect(queue.dismiss(item.operationId)).rejects.toThrow(/hasn't been sent/);
    await queue.sync(async () => sendOutcome(400, "No"));
    await queue.dismiss(item.operationId);
    expect(queue.items()).toEqual([]);
  });

  it("keeps each server, account and organisation's items apart", async () => {
    const factory = new IDBFactory();
    const { queue } = await fresh(SCOPE, factory);
    await queue.add(reportItem());
    const otherOrg = await openQueue({ ...SCOPE, organisationId: "org-2" }, { factory, locks: null, channel: false });
    const otherUser = await openQueue({ ...SCOPE, userId: "user-2" }, { factory, locks: null, channel: false });
    const otherServer = await openQueue({ ...SCOPE, server: "https://other.example.nz" }, { factory, locks: null, channel: false });
    expect([otherOrg.items(), otherUser.items(), otherServer.items()]).toEqual([[], [], []]);
    expect(await unsentForAccount(SCOPE.server, "user-1", factory)).toBe(1);
    expect(await unsentForAccount(SCOPE.server, "user-2", factory)).toBe(0);
    expect(scopeKey(SCOPE)).toBe("https%3A%2F%2Ffarm.example.nz|user-1|org-1");
  });

  it("filters by farm: a farm's items stay with it", async () => {
    const { queue } = await fresh();
    await queue.add(reportItem());
    await queue.add({ ...reportItem(), farmId: "farm-b", farmName: "Farm B" });
    expect(queue.items({ farmId: "farm-b" }).map((item) => item.farmName)).toEqual(["Farm B"]);
  });

  it("shows Unsaved when the device's storage refuses it, sends it anyway, and stores it once storage takes it again", async () => {
    const factory = new IDBFactory();
    const { queue } = await fresh(SCOPE, factory);
    const db = await openOfflineDb(factory);
    const realWrite = db.write;
    db.write = async () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
    const { item, stored } = await queue.add(reportItem());
    expect(stored).toBe(false);
    expect(queue.shownStatus(item)).toBe("unsaved");
    expect(queue.storageProblem()).toMatch(/storage is full/);
    const remote = server();
    db.write = realWrite;
    await queue.sync(remote.send);
    expect(remote.seen).toHaveLength(1);
    expect(queue.shownStatus(queue.items()[0])).toBe("synced");
    expect(queue.storageProblem()).toBeNull();
  });

  it("lets go of synced items after a week unless a waiting item uses them", () => {
    const base = { scope: "s", userId: "u", organisationId: "o", farmId: null, farmName: null, kind: "k", label: "l", attempts: 1, error: null, result: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
    const items: QueueItem[] = [
      { ...base, operationId: "old", status: "synced", syncedAt: "2026-10-01T00:00:00Z", request: { method: "POST", path: "/x", body: {} } },
      { ...base, operationId: "used", status: "synced", syncedAt: "2026-10-01T00:00:00Z", request: { method: "POST", path: "/x", body: {} } },
      { ...base, operationId: "recent", status: "synced", syncedAt: "2026-10-27T00:00:00Z", request: { method: "POST", path: "/x", body: {} } },
      { ...base, operationId: "waiting", status: "waiting", syncedAt: null, request: { method: "POST", path: "/x", body: {}, refs: [{ path: ["a"], from: "used", field: ["id"] }] } },
    ];
    expect(itemsToPrune(items, "2026-10-28T00:00:00Z").map((item) => item.operationId)).toEqual(["old"]);
    expect(bodyToSend(items[3], items)).toEqual({ a: undefined, organisationId: "o", operationId: "waiting" });
  });
});
