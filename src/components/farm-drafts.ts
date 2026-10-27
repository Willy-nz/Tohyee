"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useWorkspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/client/api";
import { createDraftStorage } from "@/lib/farming/draft-storage";
import { type Draft, type DraftStore, draftRequest, newOperationId, parseStore, prune, type SendResult, sendOutcome, storeKey, syncDrafts } from "@/lib/farming/drafts";

/*
 * The phone's copy of farm records not yet in Tohyee (#447, decisions
 * 911-913). Kept in the browser's storage, per person and organisation, and
 * sent whenever the page is open and there's a signal: on opening, when the
 * signal comes back, and after each new record. If storage is blocked or
 * full the records are kept in memory while the page is open, and the page
 * says so instead of "Saved on this phone" (#463, decision 972).
 */

const storage = createDraftStorage(() => (typeof window === "undefined" ? null : window.localStorage));

function subscribe(listener: () => void) {
  const stop = storage.subscribe(listener);
  const onStorage = () => storage.storageChanged();
  window.addEventListener("storage", onStorage);
  return () => {
    stop();
    window.removeEventListener("storage", onStorage);
  };
}

export function operationId(): string {
  return newOperationId((bytes) => crypto.getRandomValues(bytes));
}

async function send(organisationId: string, draft: Draft): Promise<SendResult> {
  const request = draftRequest(draft);
  try {
    await api(request.path, { method: request.method, body: { organisationId, ...request.body } });
    return { outcome: "done" };
  } catch (caught) {
    if (caught instanceof ApiError) return sendOutcome(caught.status, caught.message);
    // No signal, or the server didn't answer: try again later.
    return { outcome: "unreachable" };
  }
}

export function useFarmDrafts(organisationId: string) {
  const { user } = useWorkspace();
  const key = storeKey(user.id, organisationId);
  const text = useSyncExternalStore(subscribe, () => storage.read(key), () => null);
  const stored = useSyncExternalStore(subscribe, () => storage.stored(key), () => true);
  const store = useMemo(() => parseStore(text), [text]);
  const syncing = useRef(false);
  const read = useCallback(() => parseStore(storage.read(key)), [key]);
  const commit = useCallback((next: DraftStore) => storage.write(key, JSON.stringify(next)), [key]);
  const change = useCallback((edit: (current: DraftStore) => DraftStore) => commit(edit(read())), [commit, read]);
  const sync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      commit(prune(read(), new Date().toISOString()));
      // Each draft goes to its own farm's address (decision 902), whichever farm is showing.
      // Reads the latest store before each draft, so changes made while sending are kept (#462).
      await syncDrafts({ read, write: commit }, null, (draft) => send(organisationId, draft));
    } finally {
      syncing.current = false;
    }
  }, [commit, read, organisationId]);
  /** Tries again to save on the phone what's only in memory. */
  const retryStorage = useCallback(() => storage.retry(key), [key]);
  useEffect(() => {
    void sync();
    const online = () => void sync();
    window.addEventListener("online", online);
    // While records wait, try again every 30 seconds (and storage, if it refused them).
    const timer = window.setInterval(() => {
      if (!storage.stored(key)) storage.retry(key);
      if (read().drafts.some((draft) => draft.status === "saved")) void sync();
    }, 30_000);
    return () => {
      window.removeEventListener("online", online);
      window.clearInterval(timer);
    };
  }, [sync, read, key]);
  return { store, change, sync, stored, retryStorage };
}
