import { describe, expect, it } from "vitest";
import { type CalendarItem, calendarFeed, isRepeatDate, repeatDates, teamView } from "@/lib/farming/calendar-shared";

/** FC18, FC19, FC20 and FC22 (not yet reviewed): repeats, what the team sees, and the calendar link's text. */
describe("farm calendar repeats", () => {
  it("FC18 every 2 weeks until an end date", () => {
    expect(repeatDates("2026-11-03", "fortnightly", "2026-12-15", [], "2026-10-01", "2027-01-31")).toEqual(["2026-11-03", "2026-11-17", "2026-12-01", "2026-12-15"]);
    // Only the dates in the range asked for.
    expect(repeatDates("2026-11-03", "fortnightly", "2026-12-15", [], "2026-11-18", "2026-12-07")).toEqual(["2026-12-01"]);
    expect(repeatDates("2026-11-03", "weekly", null, [], "2026-11-01", "2026-11-20")).toEqual(["2026-11-03", "2026-11-10", "2026-11-17"]);
    expect(repeatDates("2026-11-03", "four_weekly", null, [], "2026-11-01", "2026-12-31")).toEqual(["2026-11-03", "2026-12-01", "2026-12-29"]);
  });

  it("FC18 monthly falls on the last day of shorter months", () => {
    expect(repeatDates("2027-01-31", "monthly", null, [], "2027-01-01", "2027-04-30")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(repeatDates("2027-01-31", "monthly", null, [], "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
    expect(repeatDates("2026-10-15", "monthly", "2027-01-14", [], "2026-01-01", "2027-12-31")).toEqual(["2026-10-15", "2026-11-15", "2026-12-15"]);
  });

  it("FC19 a skipped date is left out, the rest stay", () => {
    expect(repeatDates("2026-11-03", "fortnightly", "2026-12-15", ["2026-11-17"], "2026-11-01", "2026-12-31")).toEqual(["2026-11-03", "2026-12-01", "2026-12-15"]);
    expect(isRepeatDate("2026-11-03", "fortnightly", null, "2026-11-17")).toBe(true);
    expect(isRepeatDate("2026-11-03", "fortnightly", null, "2026-11-10")).toBe(false);
    expect(isRepeatDate("2026-11-03", "fortnightly", "2026-11-10", "2026-11-17")).toBe(false);
  });
});

const item: CalendarItem = {
  id: "7",
  key: "7",
  source: "email",
  mine: true,
  mailboxId: "1",
  kind: "animal_health",
  title: "TB testing",
  date: "2026-10-22",
  startTime: "09:00",
  endTime: null,
  tentative: false,
  change: "new",
  state: "open",
  stateNote: null,
  checkReasons: [],
  needsChecking: false,
  checked: true,
  farmId: "1",
  farmName: "Home farm",
  senderEmail: "office@manukavets.example",
  senderName: "Manuka Vets",
  subject: "TB testing",
  excerpt: "Hi Jess, we've booked TB testing at the Home farm for Thursday 22 October at 9am.",
  webLink: "https://mail.google.com/mail/#all/m1",
  sentAt: "2026-10-18T21:02:00.000Z",
  alsoSeen: 1,
  notes: "Yard at 8.30",
  repeat: null,
  repeatFrom: null,
  repeatUntil: null,
  repeatSkips: [],
  shared: false,
  sharedByName: null,
};

describe("what the farm team sees", () => {
  it("FC20 the arrangement and who shared it, nothing from the email or the notes", () => {
    const seen = teamView(item, "Jess");
    expect(seen).toMatchObject({ title: "TB testing", kind: "animal_health", date: "2026-10-22", startTime: "09:00", farmName: "Home farm", shared: true, sharedByName: "Jess", mine: false });
    expect([seen.senderEmail, seen.senderName, seen.subject, seen.excerpt, seen.webLink, seen.sentAt, seen.notes, seen.mailboxId]).toEqual([null, null, null, null, null, null, null, null]);
    expect(JSON.stringify(seen)).not.toMatch(/manukavets|booked|Yard/);
  });
});

describe("the calendar link", () => {
  const now = new Date("2026-10-19T09:00:00Z");
  const base = { kind: "animal_health" as const, tentative: false, cancelled: false, farmName: "Home farm", sharedByName: null, repeat: null, repeatUntil: null, repeatSkips: [], updatedAt: "2026-10-19T08:00:00Z" };

  it("FC22 a timed item at New Zealand time, an all-day item, a repeat with a skipped date", () => {
    const feed = calendarFeed(
      [
        { ...base, uid: "farm-kowhai-7@tohyee", title: "TB testing", date: "2026-10-22", startTime: "09:00", endTime: "10:30" },
        { ...base, uid: "farm-kowhai-8@tohyee", kind: "delivery", title: "Fert truck, Runoff", date: "2026-10-20", startTime: null, endTime: null, tentative: true, farmName: null },
        { ...base, uid: "farm-kowhai-9@tohyee", title: "Herd test", date: "2026-11-03", startTime: "07:00", endTime: null, repeat: "fortnightly", repeatUntil: "2026-12-15", repeatSkips: ["2026-11-17"] },
        { ...base, uid: "farm-kowhai-10@tohyee", kind: "other", title: "Rates", date: "2027-01-31", startTime: null, endTime: null, repeat: "monthly", cancelled: true, sharedByName: "Mere" },
      ],
      "Jess's farm calendar",
      now,
    );
    const lines = feed.split("\r\n");
    expect(feed.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(lines).toContain("X-WR-CALNAME:Jess's farm calendar");
    expect(lines).toContain("TZID:Pacific/Auckland");
    expect(lines).toContain("DTSTART;TZID=Pacific/Auckland:20261022T090000");
    expect(lines).toContain("DTEND;TZID=Pacific/Auckland:20261022T103000");
    expect(lines).toContain("DTSTART;VALUE=DATE:20261020");
    expect(lines).toContain("DTEND;VALUE=DATE:20261021");
    expect(lines).toContain("SUMMARY:Fert truck\\, Runoff");
    expect(lines).toContain("STATUS:TENTATIVE");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261215T235959Z");
    expect(lines).toContain("EXDATE;TZID=Pacific/Auckland:20261117T070000");
    expect(lines).toContain("RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).toContain("DESCRIPTION:Other. Shared by Mere. From the Tohyee farm calendar.");
    expect(lines).toContain("LOCATION:Home farm");
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(4);
  });

  it("FC22 long lines are folded at 75 bytes without splitting a character", () => {
    const feed = calendarFeed([{ ...base, uid: "u@tohyee", title: `Kōwhai ${"ā".repeat(60)}`, date: "2026-10-22", startTime: null, endTime: null }], "Farm", now);
    for (const line of feed.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    expect(feed.replace(/\r\n /g, "")).toContain(`SUMMARY:Kōwhai ${"ā".repeat(60)}`);
  });
});
