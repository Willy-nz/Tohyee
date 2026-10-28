"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOfflineQueue } from "@/components/offline-queue";
import { useWorkspace } from "@/components/workspace";
import { createDraftStorage } from "@/lib/farming/draft-storage";
import { type Draft, type DraftKind, type DraftStore, draftRequest, newOperationId, parseStore, storeKey, type Walk } from "@/lib/farming/drafts";
import { openOfflineDb } from "@/lib/offline/idb";
import { type OfflineQueue, type QueueItem, scopeKey } from "@/lib/offline/queue";

/*
 * The Log's records not yet in Tohyee (#447, decisions 911-913), kept in
 * the device's one queue (#472 stage 4, decision 1011) rather than the
 * browser's localStorage. The Log still works with a DraftStore (drafts
 * and walks), so its rules (decisions 912, 971-972) are unchanged: each
 * draft is a queue item with its operation id, sent to its own farm's
 * address; the walk in progress is kept beside the queue. Drafts kept by an
 * earlier version in localStorage are moved into the queue once, and only
 * let go from localStorage after the queue has them.
 */

const oldStorage = createDraftStorage(() => (typeof window === "undefined" ? null : window.localStorage));

export function operationId(): string {
  return newOperationId((bytes) => crypto.getRandomValues(bytes));
}

const KIND_PREFIX = "farm.";

function toDraft(item: QueueItem): Draft {
  const meta = item.meta as { draftKind?: DraftKind; payload?: Record<string, unknown>; walkId?: string | null; paddockId?: string | null };
  return {
    operationId: item.operationId,
    farmId: item.farmId ?? "",
    farmName: item.farmName ?? "",
    kind: meta.draftKind ?? "reading",
    label: item.label,
    payload: meta.payload ?? {},
    status: item.status === "synced" ? "synced" : item.status === "attention" ? "attention" : "saved",
    error: item.error,
    attempts: item.attempts,
    createdAt: item.createdAt,
    walkId: meta.walkId ?? null,
    paddockId: meta.paddockId ?? null,
  };
}

function queueInput(draft: Draft) {
  const request = draftRequest(draft);
  return {
    operationId: draft.operationId,
    kind: `${KIND_PREFIX}${draft.kind}`,
    label: draft.label,
    farmId: draft.farmId,
    farmName: draft.farmName,
    meta: { draftKind: draft.kind, payload: draft.payload, walkId: draft.walkId, paddockId: draft.paddockId },
    request: { method: request.method as "POST" | "PATCH", path: request.path, body: request.body },
  };
}

/** Applies a change to the Log's store to the queue: new drafts added, unsent ones changed, refused ones let go. */
async function applyToQueue(queue: OfflineQueue, before: DraftStore, after: DraftStore): Promise<void> {
  const old = new Map(before.drafts.map((draft) => [draft.operationId, draft]));
  const next = new Set(after.drafts.map((draft) => draft.operationId));
  for (const draft of after.drafts) {
    const was = old.get(draft.operationId);
    if (!was) await queue.add(queueInput(draft));
    else if (was.label !== draft.label || JSON.stringify(was.payload) !== JSON.stringify(draft.payload)) {
      const input = queueInput(draft);
      await queue.change(draft.operationId, { label: input.label, body: input.request.body, meta: input.meta });
    }
  }
  for (const draft of before.drafts) if (!next.has(draft.operationId)) await queue.dismiss(draft.operationId).catch(() => undefined);
}

function walksKey(scope: string) {
  return `farmWalks|${scope}`;
}

async function readWalks(key: string): Promise<Walk[]> {
  const db = await openOfflineDb();
  const record = await db.get<{ key: string; walks: Walk[] }>("meta", key);
  return record?.walks ?? [];
}

async function writeWalks(key: string, walks: Walk[]): Promise<boolean> {
  try {
    const db = await openOfflineDb();
    await db.write(["meta"], (tx) => tx.objectStore("meta").put({ key, walks }));
    return true;
  } catch {
    return false;
  }
}

export function useFarmDrafts(organisationId: string) {
  const { user } = useWorkspace();
  const { queue, items } = useOfflineQueue(organisationId);
  const key = walksKey(scopeKey({ server: typeof window === "undefined" ? "" : window.location.origin, userId: user.id, organisationId }));
  const [walks, setWalks] = useState<Walk[]>([]);
  const [walksStored, setWalksStored] = useState(true);
  const walksRef = useRef<Walk[]>([]);
  const pending = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void readWalks(key).then(
      (found) => {
        if (cancelled) return;
        walksRef.current = found;
        setWalks(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Drafts an earlier version kept in localStorage: into the queue, then let go there.
  useEffect(() => {
    if (!queue) return;
    const oldKey = storeKey(user.id, organisationId);
    const old = parseStore(oldStorage.read(oldKey));
    if (!old.drafts.length && !old.walks.length) return;
    void (async () => {
      let allStored = true;
      for (const draft of old.drafts.filter((entry) => entry.status !== "synced")) {
        const { stored } = await queue.add({ ...queueInput(draft), ready: true });
        allStored &&= stored;
      }
      if (old.walks.length) {
        const merged = [...walksRef.current.filter((walk) => !old.walks.some((entry) => entry.walkId === walk.walkId)), ...old.walks];
        allStored &&= await writeWalks(key, merged);
        walksRef.current = merged;
        setWalks(merged);
      }
      if (allStored) {
        try {
          window.localStorage.removeItem(oldKey);
        } catch {
          // Kept there too; moving it again finds the same operation ids.
        }
      }
    })();
  }, [queue, user.id, organisationId, key]);

  const store = useMemo<DraftStore>(() => ({ version: 1, drafts: items.filter((item) => item.kind.startsWith(KIND_PREFIX)).map(toDraft), walks }), [items, walks]);
  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  const change = useCallback(
    (edit: (current: DraftStore) => DraftStore) => {
      const run = async () => {
        if (!queue) return;
        const before: DraftStore = { version: 1, drafts: queue.items().filter((item) => item.kind.startsWith(KIND_PREFIX)).map(toDraft), walks: walksRef.current };
        const after = edit(before);
        await applyToQueue(queue, before, after);
        if (after.walks !== before.walks) {
          walksRef.current = after.walks;
          setWalks(after.walks);
          setWalksStored(await writeWalks(key, after.walks));
        }
      };
      pending.current = pending.current.then(run, run);
      return pending.current;
    },
    [queue, key],
  );

  const sync = useCallback(async () => {
    await pending.current.catch(() => undefined);
    if (queue && navigator.onLine) await queue.sync();
  }, [queue]);

  const stored = walksStored && !(queue && store.drafts.some((draft) => queue.items().some((item) => item.operationId === draft.operationId && queue.shownStatus(item) === "unsaved")));
  const retryStorage = useCallback(async () => {
    const ok = queue ? await queue.retryStorage() : false;
    const walksOk = await writeWalks(key, walksRef.current);
    setWalksStored(walksOk);
    return ok && walksOk;
  }, [queue, key]);

  return { store, change, sync, stored, retryStorage };
}
