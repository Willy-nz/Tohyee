import { describe, expect, it } from "vitest";
import {
  addDraft,
  type Draft,
  draftRequest,
  draftsFor,
  EMPTY_STORE,
  moveWalk,
  newOperationId,
  openWalk,
  parseStore,
  prune,
  saveWalkReading,
  sendOutcome,
  startWalk,
  syncDrafts,
  type Walk,
  waitingElsewhere,
  walkReading,
} from "@/lib/farming/drafts";

/** Records kept on the phone until they reach Tohyee (#447, decisions 911-913). */
let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const NOW = "2026-10-27T08:00:00.000Z";
const walk: Walk = {
  walkId: "walk-1",
  farmId: "1",
  farmName: "Home farm",
  measuredOn: "2026-10-27",
  method: "plate_meter",
  order: [
    { paddockId: "11", name: "1" },
    { paddockId: "12", name: "2" },
  ],
  position: 0,
  startedAt: NOW,
  finishedAt: null,
};

describe("operation ids", () => {
  it("are version 4 UUIDs from random bytes", () => {
    const id = newOperationId((bytes) => bytes.fill(0xff));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("a farm walk saved as it goes", () => {
  it("keeps each reading on the phone as it's typed, and survives closing and reopening", () => {
    let store = startWalk(EMPTY_STORE, walk);
    store = saveWalkReading(store, walk, walk.order[0], 2450, nextId, NOW);
    store = moveWalk(store, walk.walkId, 1);
    // Closing the app: the store is written to the phone's storage and read back.
    const reopened = parseStore(JSON.stringify(store));
    expect(openWalk(reopened, "1")).toMatchObject({ walkId: "walk-1", position: 1 });
    expect(walkReading(reopened, "walk-1", "11")).toMatchObject({ status: "saved", payload: { paddockId: "11", cover: 2450, measuredOn: "2026-10-27", method: "plate_meter" } });
  });

  it("changes a reading in place only while it's never been sent; after that a change is a new reading", () => {
    let store = startWalk(EMPTY_STORE, walk);
    store = saveWalkReading(store, walk, walk.order[0], 2450, nextId, NOW);
    const first = walkReading(store, "walk-1", "11")!;
    store = saveWalkReading(store, walk, walk.order[0], 2500, nextId, NOW);
    expect(store.drafts).toHaveLength(1);
    expect(walkReading(store, "walk-1", "11")).toMatchObject({ operationId: first.operationId, payload: { cover: 2500 } });
    // Tried once (maybe it arrived): a change makes a new draft and leaves the first alone.
    store = { ...store, drafts: store.drafts.map((draft) => ({ ...draft, attempts: 1 })) };
    store = saveWalkReading(store, walk, walk.order[0], 2550, nextId, NOW);
    expect(store.drafts.map((draft) => [draft.payload.cover, draft.operationId === first.operationId])).toEqual([
      [2500, true],
      [2550, false],
    ]);
  });

  it("ignores damaged storage rather than failing", () => {
    expect(parseStore("{not json")).toEqual(EMPTY_STORE);
    expect(parseStore(JSON.stringify({ version: 9 }))).toEqual(EMPTY_STORE);
  });
});

describe("syncing", () => {
  const reading = (farmId: string, operationId: string): Omit<Draft, "status" | "error" | "attempts"> => ({
    operationId,
    farmId,
    farmName: farmId === "1" ? "Home farm" : "Runoff",
    kind: "reading",
    label: "x",
    payload: { paddockId: "11", measuredOn: "2026-10-27", cover: 2400, method: "plate_meter" },
    createdAt: NOW,
    walkId: null,
    paddockId: "11",
  });

  it("sends each draft to its own farm with its operation id, so a replay finds the first", async () => {
    const store = addDraft(EMPTY_STORE, reading("1", "a0000000-0000-4000-8000-000000000001"));
    expect(draftRequest(store.drafts[0])).toEqual({
      method: "POST",
      path: "/api/farming/farms/1/pasture/readings",
      body: { paddockId: "11", measuredOn: "2026-10-27", cover: 2400, method: "plate_meter", operationId: "a0000000-0000-4000-8000-000000000001" },
    });
    const sent: string[] = [];
    // The first send's answer is lost (no signal): it stays saved and is sent again, with the same id.
    let answers = ["unreachable", "done"];
    const send = async (draft: Draft) => {
      sent.push(draft.operationId);
      const outcome = answers.shift()!;
      return outcome === "done" ? ({ outcome: "done" } as const) : ({ outcome: "unreachable" } as const);
    };
    let after = await syncDrafts(store, "1", send);
    expect(after.drafts[0]).toMatchObject({ status: "saved", attempts: 1 });
    after = await syncDrafts(after, "1", send);
    expect(after.drafts[0]).toMatchObject({ status: "synced", attempts: 2 });
    expect(sent).toEqual(["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000001"]);
    // Synced drafts aren't sent again.
    answers = ["done"];
    await syncDrafts(after, null, send);
    expect(sent).toHaveLength(2);
  });

  it("marks a refused draft as needing attention and never sends it again by itself", async () => {
    const store = addDraft(EMPTY_STORE, reading("1", "a0000000-0000-4000-8000-000000000002"));
    let calls = 0;
    const refused = async () => {
      calls += 1;
      return sendOutcome(409, "This reading was already sent with different details.");
    };
    const after = await syncDrafts(store, null, refused);
    expect(after.drafts[0]).toMatchObject({ status: "attention", error: "This reading was already sent with different details." });
    await syncDrafts(after, null, refused);
    expect(calls).toBe(1);
    expect(sendOutcome(500, "x")).toEqual({ outcome: "unreachable" });
    expect(sendOutcome(null, "offline")).toEqual({ outcome: "unreachable" });
    expect(sendOutcome(401, "signed out")).toEqual({ outcome: "unreachable" });
  });

  it("keeps drafts with the farm they were made on when the farm is switched", async () => {
    let store = addDraft(EMPTY_STORE, reading("1", "a0000000-0000-4000-8000-000000000003"));
    store = addDraft(store, reading("2", "a0000000-0000-4000-8000-000000000004"));
    // Now working on Runoff (farm 2): Home farm's draft waits for Home farm and isn't sent to Runoff.
    expect(draftsFor(store, "2").map((draft) => draft.operationId)).toEqual(["a0000000-0000-4000-8000-000000000004"]);
    expect(waitingElsewhere(store, "2")).toEqual([{ farmId: "1", farmName: "Home farm", count: 1 }]);
    const paths: string[] = [];
    await syncDrafts(store, "2", async (draft) => {
      paths.push(draftRequest(draft).path);
      return { outcome: "done" };
    });
    expect(paths).toEqual(["/api/farming/farms/2/pasture/readings"]);
    // A day out goes to the mob's own record; sending the same day out again is already done (decision 912).
    expect(draftRequest({ ...store.drafts[0], kind: "grazing_out", payload: { grazingId: "77", outOn: "2026-10-27", farmId: "1" } })).toEqual({ method: "PATCH", path: "/api/farming/grazings/77", body: { outOn: "2026-10-27", farmId: "1" } });
  });

  it("lets synced drafts go after a week, never unsynced ones", () => {
    let store = addDraft(EMPTY_STORE, { ...reading("1", "a0000000-0000-4000-8000-000000000005"), createdAt: "2026-10-01T00:00:00.000Z" });
    store = addDraft(store, { ...reading("1", "a0000000-0000-4000-8000-000000000006"), createdAt: "2026-10-01T00:00:00.000Z" });
    store = { ...store, drafts: store.drafts.map((draft, index) => (index === 0 ? { ...draft, status: "synced" } : draft)) };
    expect(prune(store, NOW).drafts.map((draft) => draft.operationId)).toEqual(["a0000000-0000-4000-8000-000000000006"]);
  });
});
