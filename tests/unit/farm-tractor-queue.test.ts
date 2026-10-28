import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { TrackPoint } from "@/lib/farming/coverage";
import { ageText, hazardNote, hazardsForMap, jobRequestBody, reviewedJob, sendState, shownHazards, TRACTOR_QUEUE_KIND, tractorQueueItem } from "@/lib/farming/tractor-queue";
import type { LocalJob } from "@/lib/farming/tractor-store";
import { openQueue, type QueueItem, type Sender } from "@/lib/offline/queue";
import type { CurrentRecord, HazardData } from "@/lib/safety/shared";

/*
 * Tractor jobs through the device's one queue, and the hazards on the
 * tractor map (#472 stage 5, decisions 1028-1030). Made-up farm and data.
 */

const SCOPE = { server: "https://farm.example.nz", userId: "user-1", organisationId: "org-1" };
const START = Date.UTC(2026, 9, 28, 9, 0, 0);

function job(overrides: Partial<LocalJob> = {}): LocalJob {
  return {
    id: "0a8f4f9e-3d1c-4b7a-9c55-1f2e3d4c5b6a",
    scope: "org-1:user-1",
    organisationId: "org-1",
    userId: "user-1",
    farmId: "farm-a",
    farmName: "Home farm",
    paddockIds: ["p1"],
    paddockNames: ["1"],
    boundaries: [],
    hazards: [],
    hazardsAt: null,
    operation: "spreading",
    equipmentId: "eq-1",
    equipmentName: "Twin-disc spreader",
    settings: [{ widthM: 12, lateralM: 0, backM: 3.5, settingsId: null }],
    recorder: { status: "finished" } as LocalJob["recorder"],
    events: [
      { t: START, kind: "start" },
      { t: START + 2000, kind: "finish" },
    ],
    state: "finished",
    startedAt: START,
    finishedAt: START + 2000,
    notes: "Top paddock",
    product: "Urea",
    declaredRate: "100",
    declaredRateUnit: "kg/ha",
    declaredQuantity: null,
    declaredQuantityUnit: "t",
    problem: null,
    sentAt: null,
    pointCount: 2,
    ...overrides,
  };
}

const points: TrackPoint[] = [
  { t: START, lon: 170.2, lat: -45.9, acc: 4, w: true, s: 0, spd: 2, b: false },
  { t: START + 1000, lon: 170.20002, lat: -45.9, acc: 4, w: true, s: 0, spd: 2, b: false },
];

function clock() {
  let time = Date.parse("2026-10-28T10:00:00.000Z");
  return () => new Date((time += 1000)).toISOString();
}

describe("a finished tractor job in the device's queue", () => {
  it("is one item under the job's id, its track a file sent as base64, sent once", async () => {
    const queue = await openQueue(SCOPE, { factory: new IDBFactory(), now: clock(), locks: null, channel: false });
    const input = tractorQueueItem(job(), points);
    const { item, stored } = await queue.add(input);
    expect(stored).toBe(true);
    expect(item.operationId).toBe(job().id);
    expect(item.kind).toBe(TRACTOR_QUEUE_KIND);
    expect(item.status).toBe("waiting");
    // The track isn't held with the item: it's a file beside it.
    expect(JSON.stringify(item.request.body)).not.toContain("points");
    // Handing it over again is the same item.
    expect((await queue.add(tractorQueueItem(job(), points))).item.createdAt).toBe(item.createdAt);
    expect(queue.items({ kind: TRACTOR_QUEUE_KIND })).toHaveLength(1);

    const bodies: Array<Record<string, unknown>> = [];
    const sender: Sender = async (_item, body) => {
      bodies.push(body);
      return { outcome: "done", result: { created: true } };
    };
    await queue.sync(sender);
    await queue.sync(sender);
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body).toMatchObject({ id: job().id, operationId: job().id, organisationId: "org-1", farmId: "farm-a", operation: "spreading", product: "Urea", declaredRate: "100", declaredRateUnit: "kg/ha", declaredQuantityUnit: null });
    const track = JSON.parse(Buffer.from(String(body.trackBase64), "base64").toString("utf8"));
    expect(track).toEqual({
      version: 1,
      settings: job().settings,
      points: [
        [START, 170.2, -45.9, 4, 1, 0, 2, 0],
        [START + 1000, 170.20002, -45.9, 4, 1, 0, 2, 0],
      ],
      events: job().events,
    });
    expect(queue.items()[0].status).toBe("synced");
    // The file is let go once Tohyee has it.
    expect(await queue.blob(job().id, "track")).toBeNull();
  });

  it("with no connection it waits, keeping the track file", async () => {
    const queue = await openQueue(SCOPE, { factory: new IDBFactory(), now: clock(), locks: null, channel: false });
    await queue.add(tractorQueueItem(job(), points));
    const report = await queue.sync(async () => ({ outcome: "unreachable" }));
    expect(report.stoppedBecause).toBe("unreachable");
    expect(queue.items()[0].status).toBe("waiting");
    expect(await queue.blob(job().id, "track")).not.toBeNull();
  });
});

describe("what the tractor page says about a finished job", () => {
  const item = (status: QueueItem["status"], error: string | null = null) => ({ operationId: job().id, status, error }) as QueueItem;
  it("follows the queue item, and says so when the item was let go", () => {
    expect(sendState(job({ state: "finished" }), undefined)).toEqual({ status: "not_queued", problem: null });
    expect(sendState(job({ state: "queued" }), item("waiting"))).toEqual({ status: "waiting", problem: null });
    expect(sendState(job({ state: "queued" }), item("waiting"), "unsaved").status).toBe("unsaved");
    expect(sendState(job({ state: "queued" }), item("attention", "That paddock isn't on this farm."))).toEqual({ status: "attention", problem: "That paddock isn't on this farm." });
    expect(sendState(job({ state: "queued" }), undefined).status).toBe("let_go");
    expect(sendState(job({ state: "sent" }), undefined).status).toBe("synced");
  });
});

describe("hazards on the tractor map", () => {
  const hazard = (title: string, extra: Partial<HazardData> = {}, change = "created") =>
    ({ recordId: title, change, data: { title, noGo: false, point: [170.2, -45.9], zone: null, removed: false, ...extra } }) as unknown as CurrentRecord<HazardData>;
  const pack = (savedAt: string) => ({ hazards: hazardsForMap([hazard("Tomo near the creek", { noGo: true })]), savedAt });
  const atStart = { hazards: hazardsForMap([hazard("Power lines")]), hazardsAt: "2026-10-28T09:00:00.000Z" };

  it("keeps only active hazards with a place", () => {
    const shown = hazardsForMap([hazard("Power lines"), hazard("Gone", { removed: true }), hazard("Withdrawn", {}, "withdrawn"), hazard("Nowhere", { point: null })]);
    expect(shown.map((entry) => entry.title)).toEqual(["Power lines"]);
  });

  it("shows the ones from the job's start, or the device's newer copy when offline", () => {
    expect(shownHazards(atStart, pack("2026-10-28T10:00:00.000Z"), true).from).toBe("job");
    const offline = shownHazards(atStart, pack("2026-10-28T10:00:00.000Z"), false);
    expect(offline).toMatchObject({ from: "device", at: "2026-10-28T10:00:00.000Z" });
    expect(offline.hazards[0]).toMatchObject({ title: "Tomo near the creek", noGo: true });
    // An older copy on the device doesn't replace what the job started with.
    expect(shownHazards(atStart, pack("2026-10-27T10:00:00.000Z"), false).from).toBe("job");
    // A job started without them uses the device's copy, online or not.
    expect(shownHazards({ hazards: [], hazardsAt: null }, pack("2026-10-27T10:00:00.000Z"), true).from).toBe("device");
    expect(shownHazards({ hazards: [], hazardsAt: null }, null, false)).toEqual({ hazards: [], at: null, from: "job" });
  });

  it("says how old the device's copy is, and that it's a reminder only", () => {
    const now = Date.parse("2026-10-28T13:00:00.000Z");
    expect(ageText("2026-10-28T12:59:50.000Z", now)).toBe("just now");
    expect(ageText("2026-10-28T12:55:00.000Z", now)).toBe("5 minutes ago");
    expect(ageText("2026-10-28T10:00:00.000Z", now)).toBe("3 hours ago");
    expect(ageText("2026-10-25T13:00:00.000Z", now)).toBe("3 days ago");
    const note = hazardNote(shownHazards(atStart, pack("2026-10-28T10:00:00.000Z"), false), now);
    expect(note).toBe("Hazards and no-go zones from what's kept on this device, updated 3 hours ago. A reminder only: they may have changed.");
    expect(hazardNote({ hazards: [], at: null, from: "device" }, now)).toBeNull();
  });
});

describe("Check and send: what was typed goes with the job (decision 1048)", () => {
  it("keeps the product, rate, quantity and notes for Send and Send later alike", () => {
    // Found testing the phone app: Send later closed without them, and the job was sent without them.
    const finished = reviewedJob(job({ state: "recording" }), { notes: " Refilled at the gate ", product: "Urea", rate: "30", rateUnit: "kg/ha", quantity: "", quantityUnit: "t" });
    expect(finished).toMatchObject({ state: "finished", notes: "Refilled at the gate", product: "Urea", declaredRate: "30", declaredRateUnit: "kg/ha", declaredQuantity: null });
    expect(jobRequestBody(finished)).toMatchObject({ product: "Urea", declaredRate: "30", declaredRateUnit: "kg/ha", declaredQuantity: null, declaredQuantityUnit: null, notes: "Refilled at the gate" });
    // Nothing typed: nothing sent, rather than empty text.
    expect(reviewedJob(job(), { notes: "  ", product: "", rate: "", rateUnit: "kg/ha", quantity: "", quantityUnit: "t" })).toMatchObject({ notes: null, product: null, declaredRate: null });
  });
});

