/*
 * The reminders the Android app turns into notifications on the phone
 * (#502, decisions 1146-1148). The server works them out from the records,
 * as Today does (GET /api/app/reminders, src/lib/native/device-reminders.ts),
 * and the phone schedules them (src/lib/native/notifications.ts). Nothing
 * is stored and no push server is used. Pure and browser-safe.
 */

export const DEVICE_REMINDER_KINDS = ["shift", "pond", "check", "service", "wof", "action", "linz_key"] as const;
export type DeviceReminderKind = (typeof DEVICE_REMINDER_KINDS)[number];

export const DEVICE_REMINDER_LABELS: Record<DeviceReminderKind, string> = {
  shift: "Shift the pods or irrigator",
  pond: "Read the pond",
  check: "Effluent checks due",
  service: "Effluent servicing",
  wof: "Effluent Warrant of Fitness",
  action: "Your safety actions",
  linz_key: "Aerial photos key running out",
};

export type DeviceReminder = {
  /** Stable for the same thing ("shift-<system>", "action-<id>"), so a refresh replaces rather than repeats it. */
  key: string;
  kind: DeviceReminderKind;
  organisationId: string;
  title: string;
  body: string;
  farmId: string | null;
  /** The Tohyee page it opens. */
  path: string;
  /** A time it's due (shifts), ISO 8601. */
  at: string | null;
  /** A day it's due (YYYY-MM-DD), told about in the morning. */
  date: string | null;
  /** Pond readings: again each morning from `date` until it's read (the next refresh drops the ones done). */
  daily?: boolean;
};

export type DeviceRemindersResponse = { organisationId: string; generatedAt: string; reminders: DeviceReminder[] };
