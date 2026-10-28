/*
 * Tohyee on a phone or tablet (#472, decisions 990-994): which device this
 * is, whether it can install Tohyee, the service worker, and the account
 * this device's offline copies belong to. Browser-safe; the pure parts are
 * tested in tests/unit/offline-device.test.ts.
 */

import { openOfflineDb } from "./idb";

export type Platform = "iphone" | "ipad" | "android" | "desktop";

/** The kind of device, from the browser's description of itself. iPads on iPadOS 13+ say they're Macs, but have touch. */
export function platformOf(userAgent: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPod/.test(userAgent)) return "iphone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return "ipad";
  if (/Android/.test(userAgent)) return "android";
  return "desktop";
}

/** Whether this browser is Safari on iPhone or iPad (other iOS browsers can add to the Home Screen from iOS 16.4, through their own Share menu). */
export function isIosSafari(userAgent: string): boolean {
  return /Safari/.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(userAgent);
}

export type AddressKind =
  /** HTTPS, or this computer (localhost): installing and offline use work. */
  | "secure"
  /** A home-network address over plain http (192.168.x.x, 10.x.x.x, a .local name). */
  | "lan"
  /** A Tailscale address over plain http (100.64.0.0/10, or a .ts.net name). */
  | "tailscale"
  /** Any other plain-http address. */
  | "insecure";

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Why installing or offline use won't work at this address, if it won't.
 * Browsers only allow a service worker on HTTPS or this computer
 * (a "secure context"), so a plain-http home-network or Tailscale address
 * can't be used offline (decision 992).
 */
export function addressKind(href: string, isSecureContext: boolean): AddressKind {
  if (isSecureContext) return "secure";
  const url = new URL(href);
  if (url.protocol === "https:") return "secure";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isTailscaleIpv4(host) || host.endsWith(".ts.net")) return "tailscale";
  if (isPrivateIpv4(host) || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa") || !host.includes(".")) return "lan";
  return "insecure";
}

/** Whether the app is running from the Home Screen (installed) rather than in a browser tab. */
export function isInstalled(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** Registers the service worker, where the browser allows one. Never throws. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
    return await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch {
    return null;
  }
}

/** Sends a message to the active service worker and waits (briefly) for its answer. Null when there's none. */
export async function tellServiceWorker<T = unknown>(message: Record<string, unknown>, timeoutMs = 4000): Promise<T | null> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
    const worker = registration?.active;
    if (!worker) return null;
    return await new Promise<T | null>((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), timeoutMs);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data as T);
      };
      worker.postMessage(message, [channel.port2]);
    });
  } catch {
    return null;
  }
}

/** How long the device's copies open without signing in online again (decision 994). Matches a session's 14 days without use. */
export const OFFLINE_SESSION_DAYS = 14;

export type DeviceAccount = { key: "account"; server: string; userId: string; verifiedAt: string };

/** Whether this device's offline copies may be opened now, and until when. */
export function offlineSession(account: Pick<DeviceAccount, "verifiedAt"> | null, now: Date): { open: boolean; expiresAt: string | null } {
  if (!account) return { open: false, expiresAt: null };
  const expires = Date.parse(account.verifiedAt) + OFFLINE_SESSION_DAYS * 86_400_000;
  if (!Number.isFinite(expires)) return { open: false, expiresAt: null };
  return { open: now.getTime() < expires, expiresAt: new Date(expires).toISOString() };
}

export async function readDeviceAccount(factory?: IDBFactory | null): Promise<DeviceAccount | null> {
  try {
    const db = await openOfflineDb(factory === undefined ? undefined : factory);
    return (await db.get<DeviceAccount>("meta", "account")) ?? null;
  } catch {
    return null;
  }
}

function accountPrefix(server: string, userId: string): string {
  return `${encodeURIComponent(server)}|${encodeURIComponent(userId)}|`;
}

/**
 * Deletes the offline farm information kept for accounts (all of them, or
 * all but `keepUserId`). Never the queue: unsent work stays, locked to its
 * account, until it's sent (decision 993).
 */
export async function clearOfflineCopies(server: string, keepUserId: string | null, factory?: IDBFactory | null): Promise<void> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const keep = keepUserId === null ? null : accountPrefix(server, keepUserId);
  await db.write(["packs", "packSections"], (tx) => {
    for (const store of ["packs", "packSections"] as const) {
      const cursorRequest = tx.objectStore(store).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const scope = String((cursor.value as { scope?: unknown }).scope ?? "");
        if (keep === null || !scope.startsWith(keep)) cursor.delete();
        cursor.continue();
      };
    }
  });
}

/**
 * Records that this account just signed in online on this device. If the
 * device's copies belonged to someone else, theirs are deleted first, so
 * only one account's copies are ever on a device (decision 993).
 */
export async function recordOnlineSignIn(server: string, userId: string, now: Date, factory?: IDBFactory | null): Promise<{ replaced: boolean }> {
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const previous = (await db.get<DeviceAccount>("meta", "account")) ?? null;
  const replaced = Boolean(previous && (previous.server !== server || previous.userId !== userId));
  if (replaced) await clearOfflineCopies(server, userId, factory);
  const account: DeviceAccount = { key: "account", server, userId, verifiedAt: now.toISOString() };
  await db.write(["meta"], (tx) => tx.objectStore("meta").put(account));
  return { replaced };
}

/** Signing out: this account's offline copies go, unsent work stays (locked to the account). */
export async function forgetAccount(server: string, userId: string, factory?: IDBFactory | null): Promise<void> {
  await clearOfflineCopies(server, null, factory);
  const db = await openOfflineDb(factory === undefined ? undefined : factory);
  const current = await db.get<DeviceAccount>("meta", "account");
  if (current && current.server === server && current.userId === userId) await db.write(["meta"], (tx) => tx.objectStore("meta").delete("account"));
}
