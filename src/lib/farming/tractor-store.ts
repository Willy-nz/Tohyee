"use client";

import type { TrackPoint } from "@/lib/farming/coverage";
import type { PaddockGeometry } from "@/lib/farming/geometry";
import type { RecorderState } from "@/lib/farming/tractor-recorder";
import type { JobSettings, Operation, TrackEvent } from "@/lib/farming/tractor-shared";

/*
 * Tractor jobs on this device (#472 stage 5, decision 1023): kept in the
 * browser's IndexedDB as they're recorded, one row per GPS fix, so closing
 * the app, a reload or a flat battery loses at most the last second. Each
 * job is kept under the server (the browser keeps each site apart), the
 * signed-in person and the organisation, so switching never mixes them.
 * A job stays here until the server has it; then it's marked sent and
 * removed a week later.
 *
 * When the shared offline queue (#472 stages 2-4) lands, sending moves to
 * it; the track itself stays here.
 */

const DB_NAME = "tohyee-tractor";
const DB_VERSION = 1;

export type LocalJobState = "recording" | "finished" | "sending" | "sent" | "needs_attention";

export type LocalJob = {
  id: string;
  /** `${organisationId}:${userId}` */
  scope: string;
  organisationId: string;
  userId: string;
  farmId: string;
  farmName: string;
  paddockIds: string[];
  paddockNames: string[];
  /** The paddocks' shapes when the job started, so the map works with no connection. */
  boundaries: Array<{ paddockId: string; geometry: PaddockGeometry }>;
  /** Hazards and no-go zones when the job started (advisory), and when they were loaded. */
  hazards: Array<{ id: string; title: string; noGo: boolean; point: [number, number] | null; ring: Array<[number, number]> | null }>;
  hazardsAt: string | null;
  operation: Operation;
  equipmentId: string | null;
  equipmentName: string | null;
  settings: JobSettings[];
  recorder: RecorderState;
  events: TrackEvent[];
  state: LocalJobState;
  startedAt: number;
  finishedAt: number | null;
  notes: string | null;
  product: string | null;
  declaredRate: string | null;
  declaredRateUnit: string | null;
  declaredQuantity: string | null;
  declaredQuantityUnit: string | null;
  /** The last problem sending, in words. */
  problem: string | null;
  sentAt: number | null;
  /** How many points are stored (the next point's number). */
  pointCount: number;
};

let opening: Promise<IDBDatabase> | null = null;

export function tractorStoreAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (!tractorStoreAvailable()) return reject(new Error("This browser can't store jobs on the device."));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs", { keyPath: "id" }).createIndex("scope", "scope");
      if (!db.objectStoreNames.contains("points")) db.createObjectStore("points", { keyPath: ["jobId", "n"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("The device's storage didn't open."));
    };
  });
  return opening;
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Saving on this device failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving on this device failed. The device may be out of space."));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Saves the job and any new points in one go. Rejects if the device refused (full or blocked). */
export async function saveLocal(job: LocalJob, points: TrackPoint[] = []): Promise<LocalJob> {
  const db = await open();
  const transaction = db.transaction(["jobs", "points"], "readwrite");
  const saved = { ...job, pointCount: job.pointCount + points.length };
  const store = transaction.objectStore("points");
  points.forEach((point, index) => store.put({ jobId: job.id, n: job.pointCount + index, p: point }));
  transaction.objectStore("jobs").put(saved);
  await done(transaction);
  return saved;
}

export async function localJobs(scope: string): Promise<LocalJob[]> {
  const db = await open();
  const transaction = db.transaction("jobs", "readonly");
  const rows = await result(transaction.objectStore("jobs").index("scope").getAll(scope) as IDBRequest<LocalJob[]>);
  return rows.sort((a, b) => b.startedAt - a.startedAt);
}

export async function localJob(id: string): Promise<LocalJob | null> {
  const db = await open();
  return ((await result(db.transaction("jobs", "readonly").objectStore("jobs").get(id))) as LocalJob | undefined) ?? null;
}

export async function localPoints(jobId: string): Promise<TrackPoint[]> {
  const db = await open();
  const range = IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]);
  const rows = (await result(db.transaction("points", "readonly").objectStore("points").getAll(range))) as Array<{ n: number; p: TrackPoint }>;
  return rows.sort((a, b) => a.n - b.n).map((row) => row.p);
}

/** Removes a job the server has had for more than a week. Never one that hasn't been sent. */
export async function forgetSent(scope: string, olderThan: number): Promise<void> {
  const jobs = await localJobs(scope);
  const db = await open();
  for (const job of jobs) {
    if (job.state !== "sent" || !job.sentAt || job.sentAt > olderThan) continue;
    const transaction = db.transaction(["jobs", "points"], "readwrite");
    transaction.objectStore("points").delete(IDBKeyRange.bound([job.id, 0], [job.id, Number.MAX_SAFE_INTEGER]));
    transaction.objectStore("jobs").delete(job.id);
    await done(transaction);
  }
}

/** How much this site is using of what the browser allows, when it says. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.quota ? { usage: estimate.usage ?? 0, quota: estimate.quota } : null;
  } catch {
    return null;
  }
}
