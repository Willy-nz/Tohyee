/*
 * Farm security cameras (#508, decisions 1216-1225): types, labels and the
 * pure rules both the server and the screens use. No server imports here.
 * Tested in tests/unit/security-camera-rules.test.ts.
 */

export type SecurityLevel = "view" | "download" | "delete";
export const SECURITY_LEVELS: readonly SecurityLevel[] = ["view", "download", "delete"];
export const SECURITY_LEVEL_LABELS: Record<SecurityLevel, string> = {
  view: "See events",
  download: "See and download",
  delete: "See, download and delete",
};

/** What the signed-in person may do with camera events (decision 1220). */
export type SecurityAccess = { view: boolean; download: boolean; delete: boolean; configure: boolean };

export type EventKind = "snapshot" | "clip";
/** What the camera detected. Reolink's file names don't say, so it's always "unknown" for now (decision 1217). */
export type Detection = "unknown" | "person" | "vehicle" | "animal" | "motion";
export const DETECTION_LABELS: Record<Detection, string> = {
  unknown: "Motion or unknown",
  person: "Person",
  vehicle: "Vehicle",
  animal: "Animal",
  motion: "Motion",
};

/** How the camera's clock compares with when Tohyee got the file (decision 1218). */
export type ClockNote = "ok" | "no_time" | "camera_ahead" | "arrived_late";

export type Camera = {
  id: string;
  farmId: string;
  farmName: string;
  name: string;
  model: string | null;
  notes: string | null;
  point: [number, number] | null;
  timeZone: string;
  quietAlertHours: number;
  isActive: boolean;
  uploadUsername: string | null;
  uploadLoginMadeAt: string | null;
  lastUploadAt: string | null;
  eventCount: number;
};

export type SecurityEvent = {
  id: string;
  cameraId: string;
  cameraName: string;
  farmId: string;
  farmName: string;
  kind: EventKind;
  detection: Detection;
  fileName: string;
  cameraLocalTime: string | null;
  cameraTimeZone: string;
  cameraAt: string | null;
  receivedAt: string;
  occurredAt: string;
  clockNote: ClockNote;
  sizeBytes: number;
  hasThumbnail: boolean;
  kept: boolean;
  keptNote: string | null;
  keptByEmail: string | null;
  keptAt: string | null;
};

// Clock -------------------------------------------------------------------------------------

/** A camera clock this far ahead of the server is wrong, not quick (decision 1218). */
export const CLOCK_AHEAD_MS = 10 * 60 * 1000;
/** A file arriving this long after the camera's time came late (offline, a backlog, or the clock is behind). */
export const ARRIVED_LATE_MS = 6 * 60 * 60 * 1000;

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Whether `timeZone` is one this server knows (IANA name, e.g. Pacific/Auckland). */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone.length > 0 && timeZone.length <= 64;
  } catch {
    return false;
  }
}

/**
 * The instant a wall-clock time ("YYYY-MM-DDTHH:MM:SS") in `timeZone` was.
 * A time skipped by daylight saving is read with the offset before the
 * change; a repeated hour as its first occurrence.
 */
export function localTimeToInstant(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  // Try the offsets in force a day either side: the earlier occurrence of a repeated hour wins.
  const candidates = [...new Set([offsetMs(wall - 86_400_000, timeZone), offsetMs(wall, timeZone), offsetMs(wall + 86_400_000, timeZone)])]
    .map((offset) => wall - offset)
    .filter((instant) => offsetMs(instant, timeZone) === wall - instant)
    .sort((a, b) => a - b);
  return new Date(candidates.length ? candidates[0] : wall - offsetMs(wall, timeZone));
}

/**
 * When an event happened, for sorting and filtering, and what to say about
 * the camera's clock (decision 1218). Both times are always kept; this only
 * chooses which one to trust. A camera time in the future (by more than 10
 * minutes) can't be right, so the received time is used.
 */
export function eventTiming(cameraAt: Date | null, receivedAt: Date): { occurredAt: Date; clockNote: ClockNote } {
  if (!cameraAt) return { occurredAt: receivedAt, clockNote: "no_time" };
  const difference = receivedAt.getTime() - cameraAt.getTime();
  if (difference < -CLOCK_AHEAD_MS) return { occurredAt: receivedAt, clockNote: "camera_ahead" };
  if (difference > ARRIVED_LATE_MS) return { occurredAt: cameraAt, clockNote: "arrived_late" };
  return { occurredAt: cameraAt, clockNote: "ok" };
}

export const CLOCK_NOTE_TEXT: Record<ClockNote, string | null> = {
  ok: null,
  no_time: "The file name had no time, so this is when Tohyee got it.",
  camera_ahead: "The camera's clock was ahead of Tohyee's, so this is when Tohyee got it. Check the camera's time in the Reolink app.",
  arrived_late: "Arrived more than 6 hours after the camera's time: the camera may have been offline, or its clock is behind.",
};

// Camera health -----------------------------------------------------------------------------

export type CameraHealth = { state: "never" | "ok" | "quiet" | "archived"; text: string };

const WEEKDAY = new Intl.DateTimeFormat("en-NZ", { weekday: "long" });
const DAY_MONTH = new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short" });

/** "for 5 minutes", "for 3 hours", "since Tuesday" within the last week, else "since 3 Nov". */
export function sinceText(last: Date, now: Date, timeZone?: string): string {
  const days = (now.getTime() - last.getTime()) / 86_400_000;
  const weekday = timeZone ? new Intl.DateTimeFormat("en-NZ", { weekday: "long", timeZone }) : WEEKDAY;
  const dayMonth = timeZone ? new Intl.DateTimeFormat("en-NZ", { day: "numeric", month: "short", timeZone }) : DAY_MONTH;
  if (days * 24 < 1) {
    const minutes = Math.max(1, Math.floor(days * 24 * 60));
    return `for ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (days < 1) {
    const hours = Math.floor(days * 24);
    return `for ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return days < 7 ? `since ${weekday.format(last)}` : `since ${dayMonth.format(last)}`;
}

/**
 * A camera's health is when its last file arrived (decision 1221): Tohyee
 * can't ask a sleeping 4G camera how it is. "Quiet" after the camera's own
 * number of hours with nothing, which may only mean nothing moved.
 */
export function cameraHealth(camera: Pick<Camera, "name" | "isActive" | "lastUploadAt" | "quietAlertHours">, now: Date, timeZone?: string): CameraHealth {
  if (!camera.isActive) return { state: "archived", text: `${camera.name} is archived and can't upload.` };
  if (!camera.lastUploadAt) return { state: "never", text: `Nothing from ${camera.name} yet.` };
  const last = new Date(camera.lastUploadAt);
  if (now.getTime() - last.getTime() > camera.quietAlertHours * 3_600_000) return { state: "quiet", text: `No uploads from ${camera.name} ${sinceText(last, now, timeZone)}.` };
  return { state: "ok", text: `Last upload ${sinceText(last, now, timeZone).replace(/^for /, "").replace(/^since /, "")} ago` };
}

// Retention ---------------------------------------------------------------------------------

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/** Events that arrived before this are removed by the clean-up, unless kept (decision 1222). Uses the received time: a wrong camera clock can't make media go early. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

export function expires(event: Pick<SecurityEvent, "kept" | "receivedAt">, retentionDays: number, now: Date): boolean {
  return !event.kept && new Date(event.receivedAt).getTime() < retentionCutoff(now, retentionDays).getTime();
}

// Access ------------------------------------------------------------------------------------

/** Owners and admins have every right; others have what they're given (decision 1220). */
export function accessFor(role: string | undefined, level: SecurityLevel | null): SecurityAccess {
  if (role === "owner" || role === "admin") return { view: true, download: true, delete: true, configure: true };
  const rank = level ? SECURITY_LEVELS.indexOf(level) : -1;
  return { view: rank >= 0, download: rank >= 1, delete: rank >= 2, configure: false };
}

/** Roles that can be given camera access; sales and report-only roles can't (decision 1220). */
export const GRANTABLE_ROLES = ["farm_worker", "viewer", "bookkeeper"] as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
