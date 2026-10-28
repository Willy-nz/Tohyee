import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { TrackPoint } from "@/lib/farming/coverage";
import { localJob, localPoints, type LocalJob, saveLocal } from "@/lib/farming/tractor-store";
import { readGapNote, type TrackSave, trackWriter, unsavedGap } from "@/lib/farming/tractor-writer";

/*
 * A tractor job kept on the device while it's recorded (#480, decision
 * 1057): a write the device refuses is tried again, in order, by the
 * next; the warning stays until everything recorded is kept; and the
 * track on the device is never one with a stretch missing. Uses the real
 * store on fake-indexeddb, with chosen writes refused. Made-up data.
 */

const START = Date.UTC(2026, 9, 28, 9, 0, 0);
let jobs = 0;

function job(overrides: Partial<LocalJob> = {}): LocalJob {
  jobs += 1;
  return {
    id: `job-${jobs}`,
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
    equipmentId: null,
    equipmentName: null,
    settings: [{ widthM: 12, lateralM: 0, backM: 3.5, settingsId: null }],
    recorder: { status: "recording" } as LocalJob["recorder"],
    events: [{ t: START, kind: "start" }],
    state: "recording",
    startedAt: START,
    finishedAt: null,
    notes: null,
    product: null,
    declaredRate: null,
    declaredRateUnit: null,
    declaredQuantity: null,
    declaredQuantityUnit: null,
    problem: null,
    sentAt: null,
    pointCount: 0,
    ...overrides,
  };
}

const fix = (index: number): TrackPoint => ({ t: START + index * 1000, lon: 170.2 + index * 0.00002, lat: -45.9, acc: 4, w: true, s: 0 });

/** The real store, refusing the writes numbered in `refuse` (1 is the first) as a full device would. */
function flakyStore(refuse: number[]) {
  let calls = 0;
  const save: TrackSave = async (record, points) => {
    calls += 1;
    if (refuse.includes(calls)) throw Object.assign(new Error("The device is out of space."), { name: "QuotaExceededError" });
    return saveLocal(record, points);
  };
  return save;
}

function memoryNotes() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key), map };
}

const noTimer = { setTimer: () => null, clearTimer: () => undefined };

describe("keeping a tractor job on the device", () => {
  it("tries a refused fix again with the next, so the device ends with the exact track", async () => {
    const start = job();
    await saveLocal(start);
    const notes = memoryNotes();
    const writer = trackWriter({ save: flakyStore([2]), initial: start, notes, ...noTimer });
    writer.push(start, [fix(0)]);
    expect(await writer.flush()).toBe(true);
    writer.push(start, [fix(1)]); // refused
    expect(await writer.flush()).toBe(false);
    expect(writer.status()).toMatchObject({ unsavedFixes: 1, kept: 1, problem: "The device is out of space.", since: fix(1).t });
    expect(readGapNote(start.id, notes)).toEqual({ jobId: start.id, from: 1, since: fix(1).t });

    // Storage recovers; the next fix's write takes the refused one with it.
    writer.push(start, [fix(2)]);
    expect(await writer.flush()).toBe(true);
    expect(writer.status()).toEqual({ unsavedFixes: 0, unsavedChanges: false, problem: null, since: null, kept: 3 });
    expect(await localPoints(start.id)).toEqual([fix(0), fix(1), fix(2)]);
    expect((await localJob(start.id))?.pointCount).toBe(3);
    expect(readGapNote(start.id, notes)).toBeNull();
  });

  it("keeps saying so while every write is refused, and never claims a fix it hasn't kept", async () => {
    const start = job();
    await saveLocal(start);
    const writer = trackWriter({ save: flakyStore([1, 2]), initial: start, notes: null, ...noTimer });
    writer.push(start, [fix(0)]);
    writer.push(start, [fix(1)]);
    expect(await writer.flush()).toBe(false);
    writer.push(start, [fix(2)]);
    expect(await writer.flush()).toBe(false);
    expect(writer.status()).toMatchObject({ unsavedFixes: 3, kept: 0 });
    expect(await localPoints(start.id)).toEqual([]);
    expect((await localJob(start.id))?.pointCount).toBe(0);
    // Then it works: all three, in order.
    expect(await writer.flush()).toBe(true);
    expect(await localPoints(start.id)).toEqual([fix(0), fix(1), fix(2)]);
  });

  it("keeps a width change refused part way, and Finish only once everything before it is kept", async () => {
    const start = job();
    await saveLocal(start);
    const writer = trackWriter({ save: flakyStore([2, 3]), initial: start, notes: null, ...noTimer });
    writer.push(start, [fix(0)]);
    await writer.flush();
    const wider = { ...start, settings: [...start.settings, { widthM: 18, lateralM: 0, backM: 3.5, settingsId: null }] };
    writer.push(wider, [fix(1)]); // refused
    expect(await writer.flush()).toBe(false);
    const finished = { ...wider, state: "finished" as const, finishedAt: START + 5000 };
    writer.push(finished); // Finish: refused too
    expect(await writer.flush()).toBe(false);
    expect((await localJob(start.id))?.state).toBe("recording");
    expect(writer.status().unsavedChanges).toBe(true);
    expect(await writer.flush()).toBe(true);
    const kept = await localJob(start.id);
    expect(kept).toMatchObject({ state: "finished", pointCount: 2 });
    expect(kept?.settings.map((entry) => entry.widthM)).toEqual([12, 18]);
    expect(await localPoints(start.id)).toEqual([fix(0), fix(1)]);
  });

  it("tries again by itself after a while", async () => {
    const start = job();
    await saveLocal(start);
    let retry: (() => void) | null = null;
    const changes: number[] = [];
    const writer = trackWriter({ save: flakyStore([1]), initial: start, notes: null, setTimer: (run) => (retry = run), clearTimer: () => undefined, onChange: (status) => changes.push(status.unsavedFixes) });
    writer.push(start, [fix(0)]);
    expect(await writer.flush()).toBe(false);
    expect(retry).not.toBeNull();
    retry!();
    await writer.flush();
    expect(await localPoints(start.id)).toEqual([fix(0)]);
    expect(changes.at(-1)).toBe(0);
  });
});

describe("reopening after Tohyee closed with fixes not kept", () => {
  it("knows there's a gap from the note, and not once those fixes were kept", () => {
    expect(unsavedGap({ jobId: "j", from: 4, since: START }, 4)).toEqual({ from: 4, since: START });
    expect(unsavedGap({ jobId: "j", from: 4, since: START }, 9)).toBeNull();
    expect(unsavedGap(null, 4)).toBeNull();
  });
});
