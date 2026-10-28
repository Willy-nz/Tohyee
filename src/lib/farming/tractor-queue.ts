import type { TrackPoint } from "@/lib/farming/coverage";
import { type JobTrack, OPERATION_LABELS, packPoint, paddockLabel } from "@/lib/farming/tractor-shared";
import type { LocalJob } from "@/lib/farming/tractor-store";
import type { NewQueueItem, QueueItem, ShownStatus } from "@/lib/offline/queue";
import { type CurrentRecord, type HazardData, hazardState } from "@/lib/safety/shared";

/*
 * Tractor jobs and the device's one queue (#472 stage 5 on stages 2-4,
 * decisions 1028-1030). The track is still kept a fix at a time in tractor
 * mode's own IndexedDB store while it's recorded (tractor-store.ts): the
 * queue keeps whole items and files, and rewriting a growing track file
 * every second would get slower as the job got longer. When a job is
 * finished it's handed to the queue as one item whose track is one file;
 * from then on the queue sends it (once, by its id) and shows its status,
 * like everything else recorded on the device. Browser-safe.
 */

export const TRACTOR_QUEUE_KIND = "tractor.job";
export const TRACTOR_JOBS_PATH = "/api/farming/tractor/jobs";

/** The job as the server takes it, without the track (that goes as a file). */
export function jobRequestBody(job: LocalJob): Record<string, unknown> {
  return {
    id: job.id,
    farmId: job.farmId,
    paddockIds: job.paddockIds,
    operation: job.operation,
    equipmentId: job.equipmentId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? job.startedAt,
    notes: job.notes,
    product: job.product,
    declaredRate: job.declaredRate,
    declaredRateUnit: job.declaredRate ? job.declaredRateUnit : null,
    declaredQuantity: job.declaredQuantity,
    declaredQuantityUnit: job.declaredQuantity ? job.declaredQuantityUnit : null,
  };
}

export function jobTrack(job: LocalJob, points: TrackPoint[]): JobTrack {
  return { version: 1, settings: job.settings, points: points.map(packPoint), events: job.events };
}

export function jobLabel(job: Pick<LocalJob, "operation" | "paddockNames" | "startedAt">): string {
  return `Tractor: ${OPERATION_LABELS[job.operation]}, ${paddockLabel(job.paddockNames)}, ${new Date(job.startedAt).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
}

/**
 * The queue item for a finished job. Its operation id is the job's id, so
 * the queue and the server both know a second send is the same job.
 */
export function tractorQueueItem(job: LocalJob, points: TrackPoint[]): NewQueueItem & { operationId: string } {
  return {
    operationId: job.id,
    kind: TRACTOR_QUEUE_KIND,
    label: jobLabel(job),
    farmId: job.farmId,
    farmName: job.farmName,
    request: { method: "POST", path: TRACTOR_JOBS_PATH, body: jobRequestBody(job), files: [{ blob: "track", field: "trackBase64" }] },
    blobs: { track: new Blob([JSON.stringify(jobTrack(job, points))], { type: "application/json" }) },
    meta: { points: points.length },
  };
}

/** What the tractor page shows for a finished job on this device, from the job and its queue item. */
export type TractorSendState = { status: ShownStatus | "let_go" | "not_queued"; problem: string | null };

export function sendState(job: Pick<LocalJob, "state">, item: QueueItem | undefined, shown?: ShownStatus): TractorSendState {
  if (job.state === "sent") return { status: "synced", problem: null };
  if (!item) {
    // Handed over before, then "Let it go" on the queue's list: the track is still here.
    if (job.state === "queued") return { status: "let_go", problem: "It was let go from the list of work on this device before Tohyee had it. The job is still on this device." };
    return { status: "not_queued", problem: null };
  }
  const status = shown ?? item.status;
  return { status, problem: status === "attention" ? item.error : null };
}

export const SEND_STATE_LABELS: Record<TractorSendState["status"], string> = {
  unsaved: "Unsaved",
  saved: "Saved on this device",
  waiting: "Waiting to send",
  synced: "Synced",
  attention: "Needs attention",
  let_go: "Not sent",
  not_queued: "Getting ready to send",
};

// Hazards on the map ---------------------------------------------------------------------------------------

export type MapHazard = LocalJob["hazards"][number];

export function hazardsForMap(hazards: Array<CurrentRecord<HazardData>>): MapHazard[] {
  return hazards
    .filter((hazard) => hazardState(hazard) === "active" && (hazard.data.point || hazard.data.zone))
    .map((hazard) => ({
      id: hazard.recordId,
      title: hazard.data.title,
      noGo: hazard.data.noGo,
      point: hazard.data.point ? [hazard.data.point[0], hazard.data.point[1]] : null,
      ring: hazard.data.zone?.coordinates[0]?.map((position) => [position[0], position[1]] as [number, number]) ?? null,
    }));
}

/** The farm's hazards as kept on the device in its offline farm pack, and when they were kept. */
export type PackHazards = { hazards: MapHazard[]; savedAt: string };

export type ShownHazards = { hazards: MapHazard[]; at: string | null; from: "job" | "device" };

/**
 * Which hazards the tractor map shows (decision 1030). Normally the ones
 * read when the job started. With no connection, the farm's offline copy
 * is used instead when it's newer (or the job started without them),
 * labelled with its age. Either way they're a reminder only.
 */
export function shownHazards(job: Pick<LocalJob, "hazards" | "hazardsAt" | "hazardsFrom">, pack: PackHazards | null, online: boolean): ShownHazards {
  const fromJob: ShownHazards = { hazards: job.hazards, at: job.hazardsAt, from: job.hazardsFrom ?? "job" };
  if (!pack) return fromJob;
  if (job.hazardsAt === null) return { hazards: pack.hazards, at: pack.savedAt, from: "device" };
  if (!online && Date.parse(pack.savedAt) > Date.parse(job.hazardsAt)) return { hazards: pack.hazards, at: pack.savedAt, from: "device" };
  return fromJob;
}

/** "5 minutes ago", "3 hours ago", "2 days ago". */
export function ageText(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/** The line under the map about the hazards shown. */
export function hazardNote(shown: ShownHazards, now: number): string | null {
  if (!shown.hazards.length) return null;
  if (shown.from === "device" && shown.at) return `Hazards and no-go zones from what's kept on this device, updated ${ageText(shown.at, now)}. A reminder only: they may have changed.`;
  return `Hazards and no-go zones as at ${shown.at ? new Date(shown.at).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" }) : "an unknown time"}: a reminder only.`;
}
