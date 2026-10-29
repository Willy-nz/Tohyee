/*
 * Farm members on the map (#498 item 7, decisions 1125-1134; not yet
 * reviewed by Jess). Browser-safe rules shared by the server
 * (src/lib/farming/locations.ts) and the screens
 * (src/components/farm-locations.tsx): how long someone may share for, which
 * fixes are too rough to show as a point, and how old a position may be
 * before it's "last known" rather than recent. Display-only numbers
 * (coordinates, metres, minutes) are plain numbers: nothing here is money.
 */

/** How long sharing lasts when the person doesn't choose (decision 1126). */
export const DEFAULT_SHARE_HOURS = 4;
/** The longest anyone can share for in one go: a long shift (decision 1126). */
export const MAX_SHARE_HOURS = 12;
/** The choices on the "Share my location" form. */
export const SHARE_HOUR_CHOICES = [1, 2, 4, 8, 12] as const;
/** Nothing about a sharing session is kept longer than this, whatever happens (decision 1127). */
export const HARD_CAP_HOURS = 24;

/** The phone sends a new position at most this often (decision 1131). */
export const SEND_EVERY_SECONDS = 20;
/** The server keeps at most one position per session this often; quicker ones are refused (decision 1131). */
export const MIN_SECONDS_BETWEEN_UPDATES = 10;
/** The map asks for everyone's latest positions this often while it's open and online. */
export const REFRESH_EVERY_SECONDS = 30;

/** Up to this old, a position is "recent": "updated 2 min ago" (decision 1129). */
export const RECENT_MINUTES = 5;
/** A fix rougher than this (metres) shows as an area, never a precise dot (decision 1130). */
export const PRECISE_METRES = 100;
/** A fix rougher than this (metres) isn't kept at all: it would put someone kilometres off. */
export const REFUSE_METRES = 2000;

export type PositionState = "recent" | "stale" | "unavailable";

export type SharedPosition = { latitude: number; longitude: number; accuracyMetres: number; at: string };

export type SharingPerson = {
  shareId: string;
  userId: string;
  name: string;
  isMe: boolean;
  farmId: string;
  startedAt: string;
  endsAt: string;
  /** The latest position only (no trail), or null before the first fix arrives. */
  position: SharedPosition | null;
};

export type MySharing = { shareId: string; farmId: string; farmName: string; startedAt: string; endsAt: string; hasPosition: boolean };

/**
 * Recent, stale ("last known") or unavailable (no position yet). Only the
 * age of the fix decides it, measured on this device's clock; a viewer who
 * is offline sees nothing as live whatever its age (`liveLabel`).
 */
export function positionState(position: Pick<SharedPosition, "at"> | null, now: Date): PositionState {
  if (!position) return "unavailable";
  const age = now.getTime() - new Date(position.at).getTime();
  if (!Number.isFinite(age)) return "unavailable";
  return age <= RECENT_MINUTES * 60_000 ? "recent" : "stale";
}

/** "just now", "1 min ago", "12 min ago", "2 h 5 min ago". A time a little ahead (clocks differ) is "just now". */
export function timeAgo(at: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(at).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min ago` : `${hours} h ago`;
}

/** Whether a fix is precise enough for a dot, or only an area ("within about 400 m"). */
export function isPrecise(accuracyMetres: number): boolean {
  return accuracyMetres <= PRECISE_METRES;
}

/** "about 8 m", "about 400 m", "about 1.5 km". */
export function accuracyText(accuracyMetres: number): string {
  if (accuracyMetres >= 1000) return `about ${(Math.round(accuracyMetres / 100) / 10).toLocaleString("en-NZ")} km`;
  return `about ${Math.max(1, Math.round(accuracyMetres)).toLocaleString("en-NZ")} m`;
}

/**
 * What a marker's card says about the position, never implying an old one is
 * live: "Updated 2 min ago", "Last known 12 min ago (not live)", "No position
 * yet". `offline`: this device can't reach Tohyee, so nothing it shows is live.
 */
export function positionLabel(position: SharedPosition | null, now: Date, offline: boolean): string {
  const state = positionState(position, now);
  if (state === "unavailable" || !position) return offline ? "No position (you're offline)" : "No position yet";
  if (offline) return `Last known ${timeAgo(position.at, now)} (not live: you're offline)`;
  if (state === "stale") return `Last known ${timeAgo(position.at, now)} (not live)`;
  return `Updated ${timeAgo(position.at, now)}`;
}

/** Up to two letters for an avatar: "Mere Tane" → "MT", "jess@example.com" → "J". */
export function initialsOf(name: string): string {
  const words = name.replace(/@.*$/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((word) => [...word][0]?.toLocaleUpperCase("en-NZ") ?? "").join("").slice(0, 2) || "?";
}

/** Avatar colours dark enough for white letters (WCAG AA) in both themes. */
export const AVATAR_COLOURS = ["#1d5fae", "#8a3ffc", "#b0306a", "#0f7b6c", "#9a5b00", "#5a6b00", "#a8341c", "#3d4f9f"] as const;

/** The same colour for the same person every time. */
export function avatarColour(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
}

/** When sharing stops for someone choosing `hours` now: whole hours from 1 to 12, else the default. */
export function shareHours(input: unknown): number | null {
  if (input === undefined || input === null || input === "") return DEFAULT_SHARE_HOURS;
  const hours = typeof input === "number" ? input : typeof input === "string" && /^\d{1,2}$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_SHARE_HOURS) return null;
  return hours;
}

/** A clock time for "until 4:35 pm". */
export function untilText(endsAt: string | Date): string {
  return new Date(endsAt).toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit" });
}

/** The short notice shown before anyone starts sharing (decision 1133; Privacy Act 2020, IPP 3). */
export const SHARING_NOTICE: string[] = [
  "Tohyee keeps only where you were last seen, how accurate it was and when. No trail of where you've been.",
  "People in this organisation who work on this farm can see it on the farm map while you share. No one else can.",
  "It only sends while Tohyee is open on this phone. Locking the phone or switching apps stops it.",
  "Your position is deleted when you stop sharing or the time runs out, and never kept for more than 24 hours. It isn't in exports, backups, the offline farm pack or AI tools.",
  "Starting and stopping are recorded (not your positions). Sharing is your choice: you can stop at any time, and no one can turn it on for you.",
];
