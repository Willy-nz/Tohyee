import { parseOptionalIsoDate } from "@/lib/dates";
import { ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";

/*
 * Time-limited access (decisions 1466-1474). A member's access can have a
 * start and an end. Both are stored as instants; people enter and read them
 * as a date and an optional time in the server's business time zone
 * (Pacific/Auckland unless TOHYEE_TIME_ZONE says otherwise). Tohyee has no
 * per-organisation time zone.
 *
 * The end is exclusive: "until 12 Dec" (no time) means through the whole of
 * 12 Dec, so it's stored as midnight at the start of 13 Dec. "Until 12 Dec
 * 5:00pm" is stored as that moment.
 *
 * Everything here is pure (no database), so the pages can use it too.
 */

/** Reminders go out this many days before access ends (decision 1471). */
export const ACCESS_REMINDER_DAYS = 3;

export type AccessWindow = { startsAt: string | null; endsAt: string | null };

/**
 * open: no limit. current: has an end, more than 3 days away. ending: ends
 * within 3 days. ended: it's past the end. not_started: before the start.
 */
export type AccessState = "open" | "current" | "ending" | "ended" | "not_started";

export function accessState(window: AccessWindow, now: Date = new Date()): AccessState {
  const at = now.getTime();
  if (window.startsAt && at < new Date(window.startsAt).getTime()) return "not_started";
  if (!window.endsAt) return "open";
  const ends = new Date(window.endsAt).getTime();
  if (at >= ends) return "ended";
  return ends - at <= ACCESS_REMINDER_DAYS * 86_400_000 ? "ending" : "current";
}

/** Whether the member may use the organisation now. */
export function accessAllowed(window: AccessWindow, now: Date = new Date()): boolean {
  const state = accessState(window, now);
  return state !== "ended" && state !== "not_started";
}

/** A date and an optional time ("HH:MM", 24-hour) as people see them. */
export type LocalMoment = { date: string; time: string | null };

function wallParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = wallParts(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant a date and time on the wall clock in `timeZone` is. */
export function zonedInstant(date: string, time: string | null, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time ?? "00:00").split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function partsOf(instant: Date, timeZone: string): { date: string; time: string } {
  const p = wallParts(instant, timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** A start as people entered it: the time is left off when it's midnight. */
export function startParts(instant: string | Date, timeZone: string): LocalMoment {
  const { date, time } = partsOf(new Date(instant), timeZone);
  return { date, time: time === "00:00" ? null : time };
}

/** An (exclusive) end as people entered it: midnight is shown as the whole day before. */
export function untilParts(instant: string | Date, timeZone: string): LocalMoment {
  const { date, time } = partsOf(new Date(instant), timeZone);
  if (time !== "00:00") return { date, time };
  return { date: addDays(date, -1), time: null };
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** One calendar month on, kept to the month's last day (31 Jan -> 28 Feb). */
export function addMonth(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const moved = new Date(Date.UTC(year, month, Math.min(day, last)));
  return `${moved.getUTCFullYear()}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** "17:00" -> "5:00pm", "09:30" -> "9:30am". */
export function formatClock(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${pad(minute)}${suffix}`;
}

/** "12 Dec 2026" or "12 Dec 2026, 5:00pm". */
export function formatMoment(moment: LocalMoment): string {
  return moment.time ? `${formatDate(moment.date)}, ${formatClock(moment.time)}` : formatDate(moment.date);
}

/** For "ends at …": "5:00pm on 12 Dec 2026", or "the end of 12 Dec 2026". */
export function formatEnd(moment: LocalMoment): string {
  return moment.time ? `${formatClock(moment.time)} on ${formatDate(moment.date)}` : `the end of ${formatDate(moment.date)}`;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTime(input: unknown, label: string): string | null {
  if (input == null || (typeof input === "string" && input.trim() === "")) return null;
  if (typeof input !== "string" || !TIME.test(input.trim())) throw new ValidationError(`${label} must be a time like 17:00.`);
  return input.trim();
}

export type AccessInput = { accessFrom?: unknown; accessFromTime?: unknown; accessUntil?: unknown; accessUntilTime?: unknown };

/**
 * The window people entered, as instants. A time without its date is
 * refused. The end must be after the start. Doesn't check against now:
 * setting an end in the past ends access, as "End now" does.
 */
export function parseAccessWindow(input: AccessInput, timeZone: string): { startsAt: Date | null; endsAt: Date | null } {
  const fromDate = parseOptionalIsoDate(input.accessFrom, "Access from");
  const fromTime = parseTime(input.accessFromTime, "The start time");
  const untilDate = parseOptionalIsoDate(input.accessUntil, "Access until");
  const untilTime = parseTime(input.accessUntilTime, "The end time");
  if (fromTime && !fromDate) throw new ValidationError("Choose the start date as well as the time.");
  if (untilTime && !untilDate) throw new ValidationError("Choose the end date as well as the time.");
  const startsAt = fromDate ? zonedInstant(fromDate, fromTime, timeZone) : null;
  const endsAt = untilDate ? (untilTime ? zonedInstant(untilDate, untilTime, timeZone) : zonedInstant(addDays(untilDate, 1), null, timeZone)) : null;
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) throw new ValidationError("Access must end after it starts.");
  return { startsAt, endsAt };
}

/**
 * Extend (decision 1470): a week or a month on from the current end, or from
 * today if it has already ended (or has no end). A time of day is kept.
 */
export function extendedEnd(endsAt: string | null, by: "week" | "month", now: Date, timeZone: string): Date {
  const today = partsOf(now, timeZone).date;
  const current = endsAt ? untilParts(endsAt, timeZone) : { date: today, time: null };
  const ended = !endsAt || new Date(endsAt).getTime() <= now.getTime();
  const from = ended ? { date: today, time: current.time } : current;
  const date = by === "week" ? addDays(from.date, 7) : addMonth(from.date);
  return from.time ? zonedInstant(date, from.time, timeZone) : zonedInstant(addDays(date, 1), null, timeZone);
}

/** What a member is told when they're refused (decision 1468). */
export function accessRefusalMessage(state: "ended" | "not_started", organisationName: string, moment: LocalMoment, askName: string | null): string {
  const ask = askName ?? "an owner of the organisation";
  if (state === "ended") return `Your access to ${organisationName} ended on ${formatMoment(moment)}. Ask ${ask} to extend it.`;
  return `Your access to ${organisationName} starts on ${formatMoment(moment)}. Ask ${ask} if you need it sooner.`;
}
