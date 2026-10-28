"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConfirmFunction } from "@/components/confirm-dialog";
import { setOfflineReader } from "@/lib/client/api";
import { forgetAccount, recordOnlineSignIn, registerServiceWorker, tellServiceWorker } from "@/lib/offline/device";
import { answerOffline, refreshPacks, type RefreshProgress } from "@/lib/offline/packs";
import { importOldSafetyDrafts } from "@/components/offline-queue";
import { PACK_REFRESH_MINUTES } from "@/lib/offline/pack-inventory";
import { openQueue, sharedQueue, unsentForAccount } from "@/lib/offline/queue";
import styles from "./offline-support.module.css";

/*
 * Tohyee on this device, in every signed-in page (#472, decisions
 * 990-998): registers the service worker, tells it who's signed in, sends
 * the queue when there's a connection, and says when there isn't one.
 */

const VERIFY_KEY = "tohyee.offline.verifiedAt";
const VERIFY_EVERY_MS = 10 * 60_000;
const SYNC_EVERY_MS = 30_000;

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** Whether the browser thinks it has a connection (true while rendering on the server). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Checks the session with Tohyee (at most every 10 minutes per tab). True when signed in online just now. */
async function verifyOnline(): Promise<boolean> {
  try {
    const last = Number(window.sessionStorage.getItem(VERIFY_KEY) ?? "0");
    if (Date.now() - last < VERIFY_EVERY_MS) return false;
  } catch {
    // No session storage: check every time.
  }
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return false;
    try {
      window.sessionStorage.setItem(VERIFY_KEY, String(Date.now()));
    } catch {
      // fine
    }
    return true;
  } catch {
    return false;
  }
}

// Offline farm packs being prepared (#472 stage 3): for the farm bar and the Offline page.
let progress: (RefreshProgress & { running: boolean }) | null = null;
const progressListeners = new Set<() => void>();
function setProgress(next: typeof progress) {
  progress = next;
  progressListeners.forEach((listener) => listener());
}

/** The pack refresh running in this tab, if any. */
export function usePackProgress() {
  return useSyncExternalStore(
    (listener) => {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },
    () => progress,
    () => null,
  );
}

const NOT_FARMING_KEY = "tohyee.offline.notFarming";

/** Keeps the person's farms on the device (decision 999). Runs at most one at a time; sections kept in the last 15 minutes are skipped. */
export async function refreshFarmPacks(userId: string, organisationId: string, options: { force?: boolean; farmId?: string } = {}) {
  try {
    if (window.sessionStorage.getItem(`${NOT_FARMING_KEY}.${organisationId}`) && !options.force) return null;
  } catch {
    // fine
  }
  if (!navigator.onLine) return null;
  setProgress({ done: 0, total: 0, farmName: null, section: null, running: true });
  try {
    const result = await refreshPacks({ server: window.location.origin, userId, organisationId }, { ...options, onProgress: (next) => setProgress({ ...next, running: true }) });
    if (result.outcome === "not_farming") {
      try {
        window.sessionStorage.setItem(`${NOT_FARMING_KEY}.${organisationId}`, "1");
      } catch {
        // fine
      }
    }
    return result;
  } catch {
    return null;
  } finally {
    setProgress(null);
  }
}

export function OfflineSupport({ userId, organisationId }: { userId: string; organisationId: string | null }) {
  const online = useOnline();
  const [unsent, setUnsent] = useState(0);

  // The service worker, who it keeps pages for, then the farm packs.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const registration = await registerServiceWorker();
      const verified = navigator.onLine ? await verifyOnline() : false;
      if (cancelled) return;
      if (verified) await recordOnlineSignIn(window.location.origin, userId, new Date()).catch(() => undefined);
      if (registration) await tellServiceWorker({ type: "context", userId, organisationId, online: verified });
      if (!cancelled && organisationId) await refreshFarmPacks(userId, organisationId);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, organisationId]);

  // Screens' reads answered from the device when Tohyee can't be reached; packs refreshed when the connection comes back.
  useEffect(() => {
    if (!organisationId) return;
    const scope = { server: window.location.origin, userId, organisationId };
    setOfflineReader(async (path, query) => {
      if (!path.startsWith("/api/farming/") && path !== "/api/farm-notebook") return null;
      if (query.organisationId !== organisationId) return null;
      const answer = await answerOffline(scope, path, query);
      return answer.found ? { body: answer.body, savedAt: answer.savedAt } : answer.locked ? { locked: true } : null;
    });
    const refresh = () => void refreshFarmPacks(userId, organisationId);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(refresh, PACK_REFRESH_MINUTES * 60_000);
    return () => {
      setOfflineReader(null);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [userId, organisationId]);

  // Sends what's waiting: now, when the connection comes back, when the app is opened again, and every 30 seconds while anything waits.
  useEffect(() => {
    if (!organisationId) return;
    let cancelled = false;
    let unsubscribe: () => void = () => undefined;
    let queuePromise: ReturnType<typeof openQueue> | null = null;
    const sync = async () => {
      if (!navigator.onLine || !queuePromise) return;
      const queue = await queuePromise.catch(() => null);
      if (queue && !cancelled) await queue.sync().catch(() => undefined);
    };
    queuePromise = sharedQueue({ server: window.location.origin, userId, organisationId });
    queuePromise.then(
      (queue) => {
        if (cancelled) return;
        void importOldSafetyDrafts(queue, userId, organisationId).catch(() => 0);
        setUnsent(queue.unsentCount());
        unsubscribe = queue.subscribe(() => setUnsent(queue.unsentCount()));
        void sync();
      },
      () => undefined,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void sync(), SYNC_EVERY_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("online", sync);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [userId, organisationId]);

  if (online) return null;
  return (
    <div className={styles.banner} role="status" data-print="hide">
      <strong>You&apos;re offline.</strong> Farm pages and farm information kept on this device still open.
      {unsent ? ` ${unsent} record${unsent === 1 ? " is" : "s are"} waiting on this device to be sent.` : " Anything you record waits on this device until Tohyee can be reached."}
    </div>
  );
}

/**
 * Before signing out (decision 993): offers to send anything not sent yet,
 * and says plainly that what can't be sent stays on this device, locked to
 * this account, until it's sent. Then removes this account's offline
 * copies (pages and farm information). False: stay signed in.
 */
export async function prepareSignOut(confirm: ConfirmFunction, userId: string, organisationIds: string[]): Promise<boolean> {
  const server = window.location.origin;
  let unsent = await unsentForAccount(server, userId).catch(() => 0);
  if (unsent > 0) {
    const send = await confirm(`${unsent} record${unsent === 1 ? " hasn't" : "s haven't"} reached Tohyee yet. Send ${unsent === 1 ? "it" : "them"} before you sign out?`, {
      title: "Not sent yet",
      confirmLabel: "Send now",
      cancelLabel: "Don't send",
    });
    if (send) {
      for (const organisationId of organisationIds) {
        const queue = await openQueue({ server, userId, organisationId }).catch(() => null);
        if (queue && queue.unsentCount() > 0) await queue.sync().catch(() => undefined);
      }
      unsent = await unsentForAccount(server, userId).catch(() => 0);
    }
    if (unsent > 0) {
      const leave = await confirm(
        `${unsent} record${unsent === 1 ? " is" : "s are"} still not sent (no connection, or Tohyee needs you to check ${unsent === 1 ? "it" : "them"}). ${unsent === 1 ? "It stays" : "They stay"} on this device, only for you, and ${unsent === 1 ? "is" : "are"} sent the next time you sign in here. Nobody else has been told about ${unsent === 1 ? "it" : "them"}.`,
        { title: "Sign out anyway?", confirmLabel: "Sign out and keep them here", cancelLabel: "Stay signed in" },
      );
      if (!leave) return false;
    }
  }
  await forgetAccount(server, userId).catch(() => undefined);
  await tellServiceWorker({ type: "signedOut" }, 2000);
  try {
    window.sessionStorage.removeItem(VERIFY_KEY);
  } catch {
    // fine
  }
  return true;
}
