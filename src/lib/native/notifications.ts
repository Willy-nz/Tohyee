import { callNative, nativeFeatures } from "@/lib/native/bridge";
import type { DeviceReminder } from "@/lib/native/reminders-shared";

/*
 * Reminders as notifications on the phone (#502, decisions 1146-1148):
 * only in the Android app, only when the person turns them on, scheduled on
 * the phone from GET /api/app/reminders and replaced whenever Tohyee opens,
 * comes back to the screen or syncs. No push server: a phone that hasn't
 * opened Tohyee for a while still has what was scheduled then, and the next
 * refresh drops what's been done.
 *
 * `planNotifications` is pure (tests/unit/native-notifications.test.ts).
 */

/** Date-only reminders (an action due, a pond to read) arrive at this hour, phone time. */
export const MORNING_HOUR = 7;
/** How far ahead is scheduled. */
export const AHEAD_DAYS = 14;
/** Android keeps a limited number of alarms per app: the nearest are kept. */
export const MAX_SCHEDULED = 60;
/** Pond readings repeat each morning for this many days (until a refresh finds them read). */
export const DAILY_DAYS = 7;

export const CHANNEL_ID = "tohyee-reminders";

export type PlannedNotification = {
  id: number;
  title: string;
  body: string;
  /** When, as an ISO time (Capacitor's Date, sent as JSON). */
  at: string;
  key: string;
  path: string;
  organisationId: string;
};

/** A positive 31-bit id from the reminder and its time, so the same one keeps its id across refreshes. */
export function notificationId(key: string, at: string): number {
  let hash = 2166136261;
  for (const char of `${key}@${at}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 1) || 1;
}

/** The phone's local morning on a date (YYYY-MM-DD). */
export function morningOf(date: string, hour = MORNING_HOUR): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, hour, 0, 0, 0);
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

/**
 * What to schedule: each reminder at its time (shifts) or the morning of
 * its day; pond readings each morning for a week. Only times still to come
 * and within two weeks: something already due is on Today, and isn't
 * notified again. Nearest first, at most MAX_SCHEDULED.
 */
export function planNotifications(reminders: readonly DeviceReminder[], now: Date, options: { hour?: number; aheadDays?: number; max?: number } = {}): PlannedNotification[] {
  const until = now.getTime() + (options.aheadDays ?? AHEAD_DAYS) * 86_400_000;
  const planned = new Map<number, PlannedNotification>();
  const add = (reminder: DeviceReminder, when: Date, suffix = "") => {
    const time = when.getTime();
    if (!Number.isFinite(time) || time <= now.getTime() || time > until) return;
    const at = when.toISOString();
    const key = `${reminder.organisationId}:${reminder.key}${suffix}`;
    const id = notificationId(key, at);
    planned.set(id, { id, title: reminder.title, body: reminder.body, at, key, path: reminder.path, organisationId: reminder.organisationId });
  };
  for (const reminder of reminders) {
    if (reminder.at) add(reminder, new Date(reminder.at));
    else if (reminder.date && /^\d{4}-\d{2}-\d{2}$/.test(reminder.date)) {
      const days = reminder.daily ? DAILY_DAYS : 1;
      for (let day = 0; day < days; day += 1) add(reminder, morningOf(addDays(reminder.date, day), options.hour), reminder.daily ? `:${day}` : "");
    }
  }
  return [...planned.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id).slice(0, options.max ?? MAX_SCHEDULED);
}

// The setting, on this phone ----------------------------------------------------------------------

const SETTING_KEY = "tohyee.app.reminders";

export function remindersOn(): boolean {
  try {
    return window.localStorage.getItem(SETTING_KEY) === "on";
  } catch {
    return false;
  }
}

export function setRemindersOn(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SETTING_KEY, "on");
    else window.localStorage.removeItem(SETTING_KEY);
  } catch {
    // The setting just isn't kept; nothing is scheduled without it.
  }
}

export function notificationsAvailable(): boolean {
  return nativeFeatures().notifications;
}

type Permission = { display?: "granted" | "denied" | "prompt" | "prompt-with-rationale" };

export async function notificationPermission(): Promise<"granted" | "denied" | "prompt" | null> {
  const result = await callNative<Permission>("LocalNotifications", "checkPermissions");
  if (!result?.display) return null;
  return result.display === "prompt-with-rationale" ? "prompt" : result.display;
}

/** Asks Android 13+ for notifications (older Android allows them). Only after the screen has said why. */
export async function askNotificationPermission(): Promise<boolean> {
  const result = await callNative<Permission>("LocalNotifications", "requestPermissions");
  return result?.display === "granted";
}

type Pending = { notifications?: Array<{ id: number; extra?: { tohyee?: boolean } | null }> };

/** Removes every reminder Tohyee scheduled on this phone (the recording notice isn't one). */
export async function cancelReminders(): Promise<void> {
  const pending = await callNative<Pending>("LocalNotifications", "getPending");
  const ours = (pending?.notifications ?? []).filter((entry) => entry.extra?.tohyee === true).map((entry) => ({ id: entry.id }));
  if (ours.length) await callNative("LocalNotifications", "cancel", { notifications: ours });
}

/** Replaces what's scheduled with `planned`. Returns how many were scheduled (0 when off, not allowed or not the app). */
export async function scheduleReminders(planned: readonly PlannedNotification[]): Promise<number> {
  if (!notificationsAvailable()) return 0;
  await cancelReminders();
  if (!remindersOn() || (await notificationPermission()) !== "granted" || !planned.length) return 0;
  await callNative("LocalNotifications", "createChannel", { id: CHANNEL_ID, name: "Farm reminders", description: "Shifts, pond readings, checks, safety actions and the aerial photos key", importance: 4, visibility: 1 });
  const result = await callNative<{ notifications?: unknown[] }>("LocalNotifications", "schedule", {
    notifications: planned.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, channelId: CHANNEL_ID, schedule: { at: entry.at, allowWhileIdle: true },
      // Not exact: an exact alarm makes Android 12+ open its "Alarms & reminders" settings on every refresh. A few minutes late is fine for these.
      isExactNotification: false, extra: { tohyee: true, key: entry.key, path: entry.path, organisationId: entry.organisationId } })),
  });
  return result ? planned.length : 0;
}

/** Where a tapped notification goes: a Tohyee page on this server, never anywhere else. */
export function tappedPath(extra: unknown): { path: string; organisationId: string | null } | null {
  if (!extra || typeof extra !== "object") return null;
  const value = extra as { tohyee?: unknown; path?: unknown; organisationId?: unknown };
  if (value.tohyee !== true || typeof value.path !== "string" || !value.path.startsWith("/") || value.path.startsWith("//")) return null;
  return { path: value.path, organisationId: typeof value.organisationId === "string" ? value.organisationId : null };
}

/**
 * Asks the server for each organisation's reminders and replaces what's
 * scheduled. An organisation that refuses (Farming off, a role without farm
 * records) just has none. Without a connection nothing changes: what was
 * scheduled stays. Returns how many were scheduled, or null if it couldn't check.
 */
export async function refreshDeviceReminders(organisationIds: readonly string[], fetcher: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<number | null> {
  if (!notificationsAvailable()) return null;
  if (!remindersOn()) {
    await cancelReminders();
    return 0;
  }
  const all: DeviceReminder[] = [];
  for (const organisationId of organisationIds) {
    try {
      const response = await fetcher(`/api/app/reminders?organisationId=${encodeURIComponent(organisationId)}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        // Refused (Farming off, a role without farm records): none from here. A server error keeps what's scheduled.
        if (response.status >= 500) return null;
        continue;
      }
      const body = (await response.json()) as { reminders?: DeviceReminder[] };
      if (Array.isArray(body.reminders)) all.push(...body.reminders);
    } catch {
      // No connection: keep what's scheduled, rather than replace it with part of it.
      return null;
    }
  }
  return scheduleReminders(planNotifications(all, now()));
}
