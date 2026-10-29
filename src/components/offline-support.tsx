"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConfirmFunction } from "@/components/confirm-dialog";
import { setOfflineReader } from "@/lib/client/api";
import { forgetAccount, isInstalled, recordOnlineSignIn, registerServiceWorker, tellServiceWorker } from "@/lib/offline/device";
import { answerOffline, refreshPacks, type RefreshProgress } from "@/lib/offline/packs";
import { clearFarmTiles, keepFarmTiles, keepsPhotosByItself } from "@/lib/farming/imagery-device";
import { importOldSafetyDrafts } from "@/components/offline-queue";
import { PACK_REFRESH_MINUTES } from "@/lib/offline/pack-inventory";
import { sessionCheck, type SessionCheck } from "@/lib/offline/account";
import { holdSending, openQueue, sharedQueue, unsentForAccount } from "@/lib/offline/queue";
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

/**
 * Checks the session with Tohyee (at most every 10 minutes per tab).
 * "verified" only when Tohyee says this same account is signed in
 * (decisions 1051-1052): a different account (signed in from another tab)
 * or no session never renews the device's offline session.
 */
async function verifyOnline(userId: string): Promise<SessionCheck | "skipped"> {
  try {
    const last = Number(window.sessionStorage.getItem(VERIFY_KEY) ?? "0");
    if (Date.now() - last < VERIFY_EVERY_MS) return "skipped";
  } catch {
    // No session storage: check every time.
  }
  let outcome: SessionCheck;
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    outcome = sessionCheck(response.status, body, userId);
  } catch {
    return "unreachable";
  }
  if (outcome === "verified") {
    try {
      window.sessionStorage.setItem(VERIFY_KEY, String(Date.now()));
    } catch {
      // fine
    }
  }
  return outcome;
}

// This tab's account was signed out and someone else signed in, in this browser (decision 1051).
let accountChanged = false;
const accountListeners = new Set<() => void>();
const ACCOUNT_CHANNEL = "tohyee-account";

/** Holds this tab's offline work and reads: they belong to the account it opened with. */
export function markAccountChanged() {
  if (accountChanged) return;
  accountChanged = true;
  holdSending(true);
  setOfflineReader(null);
  accountListeners.forEach((listener) => listener());
}

/** Whether this tab's account was replaced by another sign-in in this browser. */
export function useAccountChanged(): boolean {
  return useSyncExternalStore(
    (listener) => {
      accountListeners.add(listener);
      return () => {
        accountListeners.delete(listener);
      };
    },
    () => accountChanged,
    () => false,
  );
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
  if (!navigator.onLine || accountChanged) return null;
  setProgress({ done: 0, total: 0, farmName: null, section: null, running: true });
  try {
    const result = await refreshPacks({ server: window.location.origin, userId, organisationId }, { ...options, shouldStop: () => accountChanged, onProgress: (next) => setProgress({ ...next, running: true }) });
    if (result.outcome === "account_changed") markAccountChanged();
    if (result.outcome === "not_farming") {
      try {
        window.sessionStorage.setItem(`${NOT_FARMING_KEY}.${organisationId}`, "1");
      } catch {
        // fine
      }
    }
    // Then the farm's area of aerial photos, on phones and tablets (#485, decision 1063). Another account's go first.
    if (result.outcome === "done" && keepsPhotosByItself(navigator.userAgent, navigator.maxTouchPoints ?? 0, isInstalled())) {
      void clearFarmTiles(window.location.origin, userId).then(() => keepFarmTiles({ server: window.location.origin, userId, organisationId })).catch(() => undefined);
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
  const changed = useAccountChanged();
  const [unsent, setUnsent] = useState(0);

  // Another tab signing in as someone else holds this one (decision 1051).
  useEffect(() => {
    const server = window.location.origin;
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(ACCOUNT_CHANNEL) : null;
    const seen = (other: { server?: unknown; userId?: unknown } | null) => {
      if (other && other.server === server && typeof other.userId === "string" && other.userId !== userId) markAccountChanged();
    };
    channel?.addEventListener("message", (event: MessageEvent) => seen(event.data));
    channel?.postMessage({ server, userId });
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ACCOUNT_CHANNEL || !event.newValue) return;
      try {
        seen(JSON.parse(event.newValue));
      } catch {
        // not ours
      }
    };
    window.addEventListener("storage", onStorage);
    try {
      window.localStorage.setItem(ACCOUNT_CHANNEL, JSON.stringify({ server, userId }));
    } catch {
      // fine: the server's check still holds the work
    }
    // Coming back to this tab checks who's signed in now.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || accountChanged) return;
      void fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" })
        .then(async (response) => sessionCheck(response.status, await response.json().catch(() => null), userId))
        .then((outcome) => {
          if (outcome === "other_account") markAccountChanged();
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      channel?.close();
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  // The service worker, who it keeps pages for, then the farm packs.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const registration = await registerServiceWorker();
      const check = navigator.onLine ? await verifyOnline(userId) : "unreachable";
      if (cancelled) return;
      if (check === "other_account") {
        markAccountChanged();
        return;
      }
      const verified = check === "verified";
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
    if (accountChanged) return;
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
      if (!navigator.onLine || !queuePromise || accountChanged) return;
      const queue = await queuePromise.catch(() => null);
      if (!queue || cancelled) return;
      const report = await queue.sync().catch(() => null);
      if (report?.stoppedBecause === "account_changed") markAccountChanged();
      // Something recorded here reached Tohyee (a pond read, a run shifted): the Android app's reminders are worked out again (#502).
      if (report && report.sent > 0) window.dispatchEvent(new Event("tohyee:reminders-changed"));
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

  if (changed) {
    return (
      <div className={styles.banner} role="alert" data-print="hide">
        <strong>Someone else is signed in to Tohyee in this browser now.</strong> This tab still belongs to the account it was opened with, so nothing here is sent or refreshed.
        {unsent ? ` ${unsent} record${unsent === 1 ? " made here is" : "s made here are"} held on this device for that account. ${unsent === 1 ? "It's" : "They're"} only sent when that account signs in here again.` : ""}{" "}
        <button type="button" className={styles.bannerButton} onClick={() => window.location.reload()}>
          Continue as the account signed in now
        </button>{" "}
        <a className={styles.bannerLink} href="/login">
          Sign in again as this tab&apos;s account
        </a>
      </div>
    );
  }
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
  await clearFarmTiles(server, null);
  await tellServiceWorker({ type: "signedOut" }, 2000);
  try {
    window.sessionStorage.removeItem(VERIFY_KEY);
  } catch {
    // fine
  }
  return true;
}
