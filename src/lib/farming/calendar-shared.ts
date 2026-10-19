import { FARM_MAIL_KIND_LABELS, FARM_MAIL_KINDS } from "@/lib/farming/mail-rules";

/*
 * The farm calendar's pure parts, shared by the server and the screen
 * (decisions 573-575): kinds, repeats (FC18, FC19), what the farm team sees
 * of a shared item (FC20), and the calendar link's iCalendar text (FC22).
 */

/** The kinds read from email, and Other for items people add (FC17). */
export const CALENDAR_KINDS = [...FARM_MAIL_KINDS, "other"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export const CALENDAR_KIND_LABELS: Record<CalendarKind, string> = { ...FARM_MAIL_KIND_LABELS, other: "Other" };

export const REPEATS = ["weekly", "fortnightly", "four_weekly", "monthly"] as const;
export type Repeat = (typeof REPEATS)[number];
export const REPEAT_LABELS: Record<Repeat, string> = {
  weekly: "every week",
  fortnightly: "every 2 weeks",
  four_weekly: "every 4 weeks",
  monthly: "every month",
};
const WEEKS: Record<Exclude<Repeat, "monthly">, number> = { weekly: 1, fortnightly: 2, four_weekly: 4 };

export type CalendarItem = {
  /** The item's own id (a repeat's dates share it). */
  id: string;
  /** Unique on the screen: the id, with the date for a repeat. */
  key: string;
  source: "email" | "own";
  /** The signed-in member's own item; otherwise one someone shared (FC21). */
  mine: boolean;
  mailboxId: string | null;
  kind: CalendarKind;
  title: string;
  /** This date (for a repeat, this one of its dates). */
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  tentative: boolean;
  change: "new" | "moved" | "cancelled";
  state: "open" | "moved" | "cancelled" | "dismissed";
  stateNote: string | null;
  checkReasons: string[];
  needsChecking: boolean;
  checked: boolean;
  farmId: string | null;
  farmName: string | null;
  /** From the email: only on the member's own items. */
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  excerpt: string | null;
  webLink: string | null;
  sentAt: string | null;
  alsoSeen: number;
  /** Only on the member's own items. */
  notes: string | null;
  repeat: Repeat | null;
  /** The series' first date, for a repeat. */
  repeatFrom: string | null;
  repeatUntil: string | null;
  repeatSkips: string[];
  shared: boolean;
  sharedByName: string | null;
};

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Monthly: the start's day, or the month's last day when it's shorter (FC18, as Outlook does). */
function monthly(start: string, monthsOn: number): string {
  const [year, month, day] = start.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + monthsOn, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** A repeat's dates from `from` to `to`, after its start and up to its end, less skipped ones (FC18, FC19). */
export function repeatDates(start: string, repeat: Repeat, until: string | null, skips: readonly string[], from: string, to: string): string[] {
  const last = until && until < to ? until : to;
  const dates: string[] = [];
  if (last < start || last < from) return dates;
  if (repeat === "monthly") {
    const [startYear, startMonth] = start.split("-").map(Number);
    const [fromYear, fromMonth] = from.split("-").map(Number);
    let step = Math.max(0, (fromYear - startYear) * 12 + (fromMonth - startMonth) - 1);
    for (;;) {
      const date = monthly(start, step);
      if (date > last) break;
      if (date >= from) dates.push(date);
      step += 1;
    }
  } else {
    const every = WEEKS[repeat] * 7;
    let step = Math.max(0, Math.floor(daysBetween(start, from) / every));
    for (;;) {
      const date = addDays(start, step * every);
      if (date > last) break;
      if (date >= from) dates.push(date);
      step += 1;
    }
  }
  return dates.filter((date) => !skips.includes(date));
}

/** Whether `date` is one of a repeat's dates (skipped or not). */
export function isRepeatDate(start: string, repeat: Repeat, until: string | null, date: string): boolean {
  return repeatDates(start, repeat, until, [], date, date).length === 1;
}

/**
 * What everyone in the organisation sees of a shared item (FC20): the
 * arrangement, never where it came from. The preview before sharing shows
 * exactly this, and the server sends nothing more to the team.
 */
export function teamView(item: CalendarItem, sharedByName: string | null): CalendarItem {
  return {
    ...item,
    mine: false,
    mailboxId: null,
    checkReasons: [],
    needsChecking: false,
    senderEmail: null,
    senderName: null,
    subject: null,
    excerpt: null,
    webLink: null,
    sentAt: null,
    alsoSeen: 0,
    notes: null,
    repeatSkips: [],
    shared: true,
    sharedByName,
  };
}

// The calendar link (FC22) ---------------------------------------------------------------------

export type FeedEvent = {
  uid: string;
  kind: CalendarKind;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  tentative: boolean;
  cancelled: boolean;
  farmName: string | null;
  sharedByName: string | null;
  repeat: Repeat | null;
  repeatUntil: string | null;
  repeatSkips: string[];
  updatedAt: string;
};

const NZ_ZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Pacific/Auckland",
  "BEGIN:STANDARD",
  "DTSTART:19700405T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
  "TZOFFSETFROM:+1300",
  "TZOFFSETTO:+1200",
  "TZNAME:NZST",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700927T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=-1SU",
  "TZOFFSETFROM:+1200",
  "TZOFFSETTO:+1300",
  "TZNAME:NZDT",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

function text(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines over 75 octets are folded (RFC 5545 3.1), without splitting a character. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = Buffer.byteLength(char, "utf8");
    if (size + width > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const compactDate = (date: string) => date.replace(/-/g, "");
const compactTime = (time: string) => `${time.replace(":", "")}00`;
const stamp = (iso: string) => `${new Date(iso).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

function rule(event: FeedEvent): string | null {
  if (!event.repeat) return null;
  let value: string;
  if (event.repeat === "monthly") {
    const day = Number(event.date.slice(8));
    // From the 29th on, the last day of shorter months (FC18).
    value = day <= 28 ? `FREQ=MONTHLY;BYMONTHDAY=${day}` : `FREQ=MONTHLY;BYMONTHDAY=${Array.from({ length: day - 27 }, (_, index) => 28 + index).join(",")};BYSETPOS=-1`;
  } else {
    value = `FREQ=WEEKLY;INTERVAL=${WEEKS[event.repeat]}`;
  }
  if (event.repeatUntil) value += `;UNTIL=${compactDate(event.repeatUntil)}${event.startTime ? "T235959Z" : ""}`;
  return `RRULE:${value}`;
}

/** The calendar link's iCalendar text (FC22): no email content, no notes. */
export function calendarFeed(events: FeedEvent[], name: string, now: Date): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tohyee//Farm calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${text(name)}`, "X-WR-TIMEZONE:Pacific/Auckland", ...NZ_ZONE];
  for (const event of events) {
    lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp(now.toISOString())}`, `LAST-MODIFIED:${stamp(event.updatedAt)}`);
    if (event.startTime) {
      lines.push(`DTSTART;TZID=Pacific/Auckland:${compactDate(event.date)}T${compactTime(event.startTime)}`);
      if (event.endTime) lines.push(`DTEND;TZID=Pacific/Auckland:${compactDate(event.date)}T${compactTime(event.endTime)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`, `DTEND;VALUE=DATE:${compactDate(addDays(event.date, 1))}`);
    }
    const repeat = rule(event);
    if (repeat) lines.push(repeat);
    for (const skip of event.repeatSkips) {
      lines.push(event.startTime ? `EXDATE;TZID=Pacific/Auckland:${compactDate(skip)}T${compactTime(event.startTime)}` : `EXDATE;VALUE=DATE:${compactDate(skip)}`);
    }
    lines.push(`SUMMARY:${text(event.title)}`);
    if (event.farmName) lines.push(`LOCATION:${text(event.farmName)}`);
    const about = [CALENDAR_KIND_LABELS[event.kind], event.tentative ? "Tentative" : null, event.sharedByName ? `Shared by ${event.sharedByName}` : null].filter(Boolean).join(". ");
    lines.push(`DESCRIPTION:${text(`${about}. From the Tohyee farm calendar.`)}`, `CATEGORIES:${text(CALENDAR_KIND_LABELS[event.kind])}`);
    // An item with no time doesn't make the whole day busy.
    lines.push(`STATUS:${event.cancelled ? "CANCELLED" : event.tentative ? "TENTATIVE" : "CONFIRMED"}`, `TRANSP:${event.startTime ? "OPAQUE" : "TRANSPARENT"}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** A folder (Outlook) or label (Gmail) a farm mailbox reads (#340; FC25). Its name is private to the member. */
export type ChosenFolder = { id: string; externalId: string; name: string; includeSubfolders: boolean; missing: boolean };

/** What a mailbox reads (FC25, FC26): its folders, or that it reads nothing yet. */
export function folderSummary(folders: ChosenFolder[]): string {
  if (!folders.length) return "Not reading: no folders chosen";
  return `Reads ${folders.map((folder) => `${folder.name}${folder.includeSubfolders ? " and its subfolders" : ""}${folder.missing ? " (not found in the mailbox)" : ""}`).join("; ")}`;
}
