"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useWorkspace } from "@/components/workspace";
import { api, ApiError } from "@/lib/client/api";
import { type Draft, type DraftStore, draftRequest, newOperationId, parseStore, prune, type SendResult, sendOutcome, storeKey, syncDrafts } from "@/lib/farming/drafts";

/*
 * The phone's copy of farm records not yet in Tohyee (#447, decisions
 * 911-913). Kept in the browser's storage (in memory if storage is
 * blocked), per person and organisation, and sent whenever the page is open
 * and there's a signal: on opening, when the signal comes back, and after
 * each new record.
 */

const memory = new Map<string, string>();
const listeners = new Set<() => void>();

function readRaw(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked or full: the copy in memory lasts while the page is open.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => {
    memory.clear();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
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
  const text = useSyncExternalStore(subscribe, () => readRaw(key), () => null);
  const store = useMemo(() => parseStore(text), [text]);
  const syncing = useRef(false);
  const commit = useCallback((next: DraftStore) => writeRaw(key, JSON.stringify(next)), [key]);
  const change = useCallback((edit: (current: DraftStore) => DraftStore) => commit(edit(parseStore(readRaw(key)))), [commit, key]);
  const sync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      // Each draft goes to its own farm's address (decision 902), whichever farm is showing.
      await syncDrafts(prune(parseStore(readRaw(key)), new Date().toISOString()), null, (draft) => send(organisationId, draft), (next) => {
        // Keep anything added while sending: merge by operation id.
        const latest = parseStore(readRaw(key));
        const sent = new Map(next.drafts.map((draft) => [draft.operationId, draft]));
        commit({ ...latest, drafts: latest.drafts.map((draft) => sent.get(draft.operationId) ?? draft) });
      });
    } finally {
      syncing.current = false;
    }
  }, [commit, key, organisationId]);
  useEffect(() => {
    void sync();
    const online = () => void sync();
    window.addEventListener("online", online);
    // While records wait, try again every 30 seconds.
    const timer = window.setInterval(() => {
      if (parseStore(readRaw(key)).drafts.some((draft) => draft.status === "saved")) void sync();
    }, 30_000);
    return () => {
      window.removeEventListener("online", online);
      window.clearInterval(timer);
    };
  }, [sync, key]);
  return { store, change, sync };
}
