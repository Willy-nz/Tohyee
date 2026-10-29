"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useHydrated } from "@/components/hooks";
import { useWorkspace } from "@/components/workspace";
import { inNativeApp, type NativeFeatures, nativeFeatures, nativePlugin } from "@/lib/native/bridge";
import { cancelReminders, refreshDeviceReminders, tappedPath } from "@/lib/native/notifications";

/*
 * The Android app's part of every signed-in page (#502, decisions
 * 1143-1148). Nothing happens in a browser: the component renders nothing
 * and returns at once.
 *
 * - Android's back button closes an open sheet or dialog, else goes back a
 *   page, else puts Tohyee in the background (never closes it mid-job).
 * - A tapped reminder opens its page, in its organisation.
 * - Reminders on the phone are refreshed when Tohyee opens, comes back to
 *   the screen, gets its connection back, and every 30 minutes.
 *
 * Links to other websites already open in the phone's browser: the app
 * only shows the Tohyee server's own address (android/, decision 1142).
 */

const REFRESH_MINUTES = 30;
const USER_KEY = "tohyee.app.remindersUser";

type Listener = { remove: () => Promise<void> | void };
type AppPlugin = { addListener: (event: string, callback: (data: { canGoBack?: boolean }) => void) => Listener | Promise<Listener>; minimizeApp?: () => Promise<void> };
type NotificationsPlugin = { addListener: (event: string, callback: (data: { notification?: { extra?: unknown } }) => void) => Listener | Promise<Listener> };

/** The open sheet or dialog on top, if any. */
function openDialog(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]')].filter((element) => element.offsetParent !== null || element.getClientRects().length > 0);
  return dialogs.at(-1) ?? null;
}

/** Closes a dialog the way a keyboard user would: Escape, then its own Close or Cancel button. */
function closeDialog(dialog: HTMLElement): void {
  const escape = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  const target = dialog.contains(document.activeElement) ? (document.activeElement as HTMLElement) : dialog;
  const handled = !target.dispatchEvent(escape);
  if (handled) return;
  if (dialog instanceof HTMLDialogElement) {
    dialog.close();
    return;
  }
  const close = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => /^(close|cancel|keep going|not now|back)$/i.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()));
  close?.click();
}

export function NativeAppSupport() {
  const { user, organisations, selectOrganisation } = useWorkspace();
  const router = useRouter();
  const organisationIds = organisations.map((organisation) => organisation.id).join(",");
  const navigate = useRef({ router, selectOrganisation });
  useEffect(() => {
    navigate.current = { router, selectOrganisation };
  }, [router, selectOrganisation]);

  // Back button and tapped reminders.
  useEffect(() => {
    if (!inNativeApp()) return;
    const listeners: Array<Listener | Promise<Listener>> = [];
    const app = nativePlugin<AppPlugin>("App");
    if (app?.addListener) {
      listeners.push(
        app.addListener("backButton", ({ canGoBack }) => {
          const dialog = openDialog();
          if (dialog) closeDialog(dialog);
          else if (canGoBack || window.history.length > 1) window.history.back();
          else void app.minimizeApp?.();
        }),
      );
    }
    const notifications = nativePlugin<NotificationsPlugin>("LocalNotifications");
    if (notifications?.addListener) {
      listeners.push(
        notifications.addListener("localNotificationActionPerformed", ({ notification }) => {
          const target = tappedPath(notification?.extra);
          if (!target) return;
          if (target.organisationId) navigate.current.selectOrganisation(target.organisationId);
          navigate.current.router.push(target.path);
        }),
      );
    }
    return () => {
      for (const listener of listeners) void Promise.resolve(listener).then((entry) => entry.remove());
    };
  }, []);

  // Reminders: someone else signing in on this phone never gets the last person's; refreshed on open, return, reconnect and every 30 minutes.
  useEffect(() => {
    if (!inNativeApp()) return;
    let cancelled = false;
    const ids = organisationIds ? organisationIds.split(",") : [];
    const refresh = async () => {
      if (cancelled || !navigator.onLine) return;
      await refreshDeviceReminders(ids).catch(() => null);
    };
    void (async () => {
      let before: string | null = null;
      try {
        before = window.localStorage.getItem(USER_KEY);
        window.localStorage.setItem(USER_KEY, user.id);
      } catch {
        before = null;
      }
      if (before && before !== user.id) await cancelReminders().catch(() => undefined);
      await refresh();
    })();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("tohyee:reminders-changed", onOnline);
    const timer = window.setInterval(() => void refresh(), REFRESH_MINUTES * 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("tohyee:reminders-changed", onOnline);
      window.clearInterval(timer);
    };
  }, [user.id, organisationIds]);

  return null;
}

const NO_FEATURES: NativeFeatures = { app: false, backgroundLocation: false, notifications: false, camera: false, changeAddress: false };

/** What the Android app around this page can do; nothing before hydration and in a browser. */
export function useNativeFeatures(): NativeFeatures {
  const hydrated = useHydrated();
  return hydrated ? nativeFeatures() : NO_FEATURES;
}
