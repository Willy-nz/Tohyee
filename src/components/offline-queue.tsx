"use client";

import { useEffect, useState } from "react";
import { useOnline } from "@/components/offline-support";
import { Badge, Button, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { ApiError } from "@/lib/client/api";
import { compressPhoto, type PhotoPlace, photoPlace } from "@/lib/offline/photos";
import { newOperationId, type NewQueueItem, type OfflineQueue, QUEUE_STATUS_HELP, QUEUE_STATUS_LABELS, type QueueItem, type QueueRef, type ShownStatus, sharedQueue } from "@/lib/offline/queue";
import type { SafetyFile } from "@/lib/safety/files";
import { createDraftStore } from "@/lib/client/safety-drafts";
import styles from "./offline-queue.module.css";

/*
 * Work recorded on the device, on screen (#472 stage 4, decisions
 * 1008-1016): sending through the one queue, photos kept on the device
 * until they can go, and the honest list of what's waiting.
 */

/** The page's queue for this person and organisation, and its items (re-rendered on every change). */
export function useOfflineQueue(organisationId: string): { queue: OfflineQueue | null; items: QueueItem[]; problem: string | null; failed: boolean } {
  const { user } = useWorkspace();
  const [state, setState] = useState<{ key: string; queue: OfflineQueue | null; items: QueueItem[]; problem: string | null; failed: boolean }>({ key: "", queue: null, items: [], problem: null, failed: false });
  const key = `${user.id}|${organisationId}`;
  useEffect(() => {
    let stop = () => undefined as void;
    let cancelled = false;
    sharedQueue({ server: window.location.origin, userId: user.id, organisationId }).then(
      (queue) => {
        if (cancelled) return;
        const update = () => setState({ key, queue, items: queue.items(), problem: queue.storageProblem(), failed: false });
        update();
        stop = queue.subscribe(update);
      },
      () => {
        if (!cancelled) setState({ key, queue: null, items: [], problem: "This browser can't keep records on this device, so they can only be recorded with a connection.", failed: true });
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [key, user.id, organisationId]);
  return state.key === key ? state : { queue: null, items: [], problem: null, failed: false };
}

export type SubmitResult = { state: "synced"; result: unknown; item: QueueItem } | { state: "waiting" | "unsaved"; item: QueueItem };

/**
 * Records something through the queue (decision 1008): kept on the device
 * first, then sent straight away if Tohyee can be reached. If Tohyee
 * refuses it straight away, it's taken off the device again and the error
 * is thrown, as a form expects; with no connection it waits, and the
 * screen says so. Never used for approvals (the queue refuses them).
 */
export async function submitThroughQueue(queue: OfflineQueue | null, input: NewQueueItem & { operationId: string }): Promise<SubmitResult> {
  if (!queue) throw new ApiError("This browser can't keep records on this device. Try again with a connection.", 0, "no_storage");
  const { item: added } = await queue.add(input);
  if (navigator.onLine) await queue.sync();
  const item = queue.items().find((entry) => entry.operationId === added.operationId) ?? added;
  if (item.status === "synced") return { state: "synced", result: item.result, item };
  if (item.status === "attention") {
    const message = item.error ?? "Tohyee refused it.";
    await queue.dismiss(item.operationId);
    throw new ApiError(message, 400);
  }
  return { state: queue.shownStatus(item) === "unsaved" ? "unsaved" : "waiting", item };
}

/** A photo kept on the device until it can go: it's shown like a kept file, marked pending. */
export type PickedFile = SafetyFile & { pending?: boolean };

/**
 * Keeps a photo or PDF for a safety record (decision 1012): a compressed
 * copy for photos, the phone's time, and where it was taken if asked. Its
 * operation id becomes the file's id on Tohyee, so a record can name it
 * before it's sent. Sent straight away when there's a connection.
 */
export async function pickSafetyFile(queue: OfflineQueue | null, input: { farm: { id: string; name: string }; file: File; restricted?: boolean; place?: boolean }): Promise<PickedFile> {
  const operationId = newOperationId();
  const blob = input.file.type.startsWith("image/") ? await compressPhoto(input.file) : input.file;
  const contentType = blob.type || input.file.type;
  const place: PhotoPlace | null = input.place ? await photoPlace() : null;
  const phoneFileTime = input.file.lastModified ? new Date(input.file.lastModified).toISOString() : new Date().toISOString();
  const name = contentType === "image/jpeg" && !/\.jpe?g$/i.test(input.file.name) ? `${input.file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg` : input.file.name;
  const outcome = await submitThroughQueue(queue, {
    operationId,
    kind: "safety.file",
    label: `Photo: ${name}`,
    farmId: input.farm.id,
    farmName: input.farm.name,
    request: { method: "POST", path: "/api/farming/safety/files", body: { farmId: input.farm.id, fileName: name, contentType, phoneFileTime, restricted: input.restricted === true, place }, files: [{ blob: "file", field: "contentBase64" }] },
    blobs: { file: blob },
  });
  if (outcome.state === "synced") return (outcome.result as { file: SafetyFile }).file;
  return { id: operationId, name, sha256: "", contentType, sizeBytes: blob.size, photoTaken: null, phoneFileTime, receivedAt: "", uploadedByEmail: "", restricted: input.restricted === true, place, pending: true };
}

/** Refs that make a record wait for its pending files, which are named by id in `files` at `path` (e.g. ["files"]). */
export function waitForFiles(files: PickedFile[], path: string[]): QueueRef[] {
  return files.flatMap((file, index) => (file.pending ? [{ path: [...path, String(index), "id"], from: file.id, field: ["file", "id"] }] : []));
}

const TONE: Record<ShownStatus, "neutral" | "blue" | "green" | "amber" | "red"> = { unsaved: "red", saved: "neutral", waiting: "amber", synced: "green", attention: "red" };

export function QueueBadge({ status }: { status: ShownStatus }) {
  return <Badge tone={TONE[status]}>{QUEUE_STATUS_LABELS[status]}</Badge>;
}

/**
 * What's on this device for a farm (decision 1009): each record's status in
 * words, Tohyee's reason when it was refused, and Send now / Let go.
 * Synced records stay listed for the day so people can see they went.
 */
export function QueuedWork({ organisationId, farmId, kinds, title = "Recorded on this device", onSynced }: { organisationId: string; farmId: string; kinds?: string[]; title?: string; onSynced?: () => void }) {
  const { queue, items, problem } = useOfflineQueue(organisationId);
  // Something reached Tohyee: the screen's server records are read again.
  const syncedCount = items.filter((item) => item.status === "synced").length;
  useEffect(() => {
    if (syncedCount) onSynced?.();
  }, [syncedCount, onSynced]);
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const today = new Date().toDateString();
  const shown = items.filter((item) => item.farmId === farmId && item.kind !== "safety.file" && (!kinds || kinds.some((kind) => item.kind.startsWith(kind))) && (item.status !== "synced" || new Date(item.syncedAt ?? item.updatedAt).toDateString() === today));
  const elsewhere = items.filter((item) => item.farmId !== farmId && item.status !== "synced" && item.kind !== "safety.file").length;
  if (!shown.length && !problem && !elsewhere) return null;
  const waiting = shown.filter((item) => item.status === "waiting").length;
  return (
    <section className={styles.list} aria-label={title}>
      <h2 className={styles.title}>{title}</h2>
      {problem ? <p className={styles.problem}>{problem}</p> : null}
      <ul>
        {shown.map((item) => {
          const status = queue ? queue.shownStatus(item) : item.status;
          return (
            <li key={item.operationId}>
              <div className={styles.row}>
                <span className={styles.label}>{item.label}</span>
                <QueueBadge status={status} />
              </div>
              <p className={ui.muted}>
                {QUEUE_STATUS_HELP[status]} Recorded on this device {new Date(item.createdAt).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}.
              </p>
              {item.error ? <p className={styles.problem}>Tohyee said: {item.error}</p> : null}
              {item.status === "attention" && queue ? (
                <Button type="button" variant="secondary" onClick={() => void queue.dismiss(item.operationId)}>
                  Let it go
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {elsewhere ? <p className={ui.muted}>{elsewhere} more waiting for other farms. They go to their own farm.</p> : null}
      {waiting && queue ? (
        <Button
          type="button"
          variant="secondary"
          disabled={!online || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await queue.sync();
            } finally {
              setBusy(false);
            }
          }}
        >
          {online ? "Send now" : "Waiting for a connection"}
        </Button>
      ) : null}
    </section>
  );
}

/** For a screen showing server records: this device's unsent items of a kind, with their meta (a machine's pending check, a pending sign-in). */
export function pendingOf(items: QueueItem[], kind: string, farmId: string): QueueItem[] {
  return items.filter((item) => item.kind === kind && item.farmId === farmId && item.status !== "synced");
}

/**
 * Safety reports an earlier version kept in localStorage (decision 944):
 * moved into the queue with their operation ids, then let go there once the
 * queue has them (decision 1010).
 */
export async function importOldSafetyDrafts(queue: OfflineQueue, userId: string, organisationId: string): Promise<number> {
  const old = createDraftStore(() => (typeof window === "undefined" ? null : window.localStorage));
  let moved = 0;
  for (const draft of old.list(userId, organisationId)) {
    const { organisationId: _organisation, operationId: _operation, ...body } = draft.body as Record<string, unknown>;
    void _organisation;
    void _operation;
    const { stored } = await queue.add({ operationId: draft.operationId, kind: "safety.report", label: draft.label, farmId: draft.farmId, farmName: draft.farmName, request: { method: "POST", path: draft.path, body } });
    if (stored) {
      old.remove(draft.operationId);
      moved += 1;
    }
  }
  return moved;
}
