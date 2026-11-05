import { describe, expect, it } from "vitest";
import {
  accessRefusalMessage,
  accessState,
  addMonth,
  extendedEnd,
  formatEnd,
  formatMoment,
  parseAccessWindow,
  startParts,
  untilParts,
  zonedInstant,
} from "@/lib/organisations/access-window";
import { describeEvent } from "@/lib/organisations/activity";
import { matchesAccessFilter } from "@/components/member-access";

const NZ = "Pacific/Auckland";

/** Time-limited access (decisions 1466-1474): the dates people enter, as instants and back. */
describe("access dates", () => {
  it("reads a date and time as New Zealand time, in summer and winter", () => {
    // 12 Dec is daylight time (UTC+13); 12 Jun is standard time (UTC+12).
    expect(zonedInstant("2026-12-12", "17:00", NZ).toISOString()).toBe("2026-12-12T04:00:00.000Z");
    expect(zonedInstant("2026-06-12", "17:00", NZ).toISOString()).toBe("2026-06-12T05:00:00.000Z");
    expect(zonedInstant("2026-12-13", null, NZ).toISOString()).toBe("2026-12-12T11:00:00.000Z");
  });

  it("'until 12 Dec' lasts the whole day; with a time it ends then", () => {
    const allDay = parseAccessWindow({ accessUntil: "2026-12-12" }, NZ);
    expect(allDay.endsAt?.toISOString()).toBe("2026-12-12T11:00:00.000Z");
    expect(untilParts(allDay.endsAt!, NZ)).toEqual({ date: "2026-12-12", time: null });
    const atFive = parseAccessWindow({ accessUntil: "2026-12-12", accessUntilTime: "17:00" }, NZ);
    expect(untilParts(atFive.endsAt!, NZ)).toEqual({ date: "2026-12-12", time: "17:00" });
    expect(formatMoment(untilParts(atFive.endsAt!, NZ))).toBe("12 Dec 2026, 5:00pm");
    expect(formatEnd(untilParts(atFive.endsAt!, NZ))).toBe("5:00pm on 12 Dec 2026");
    expect(formatEnd(untilParts(allDay.endsAt!, NZ))).toBe("the end of 12 Dec 2026");
  });

  it("a start at midnight shows with no time", () => {
    const window = parseAccessWindow({ accessFrom: "2026-12-01" }, NZ);
    expect(startParts(window.startsAt!, NZ)).toEqual({ date: "2026-12-01", time: null });
    const at = parseAccessWindow({ accessFrom: "2026-12-01", accessFromTime: "08:30" }, NZ);
    expect(startParts(at.startsAt!, NZ)).toEqual({ date: "2026-12-01", time: "08:30" });
  });

  it("refuses an end before the start, a time without a date, and bad times", () => {
    expect(() => parseAccessWindow({ accessFrom: "2026-12-12", accessUntil: "2026-12-11" }, NZ)).toThrow("Access must end after it starts.");
    expect(() => parseAccessWindow({ accessUntilTime: "17:00" }, NZ)).toThrow("Choose the end date as well as the time.");
    expect(() => parseAccessWindow({ accessUntil: "2026-12-12", accessUntilTime: "5pm" }, NZ)).toThrow("17:00");
    expect(() => parseAccessWindow({ accessUntil: "2026-02-30" }, NZ)).toThrow("not a real date");
    // The same day, from 9am until the end of it, is fine.
    expect(parseAccessWindow({ accessFrom: "2026-12-12", accessFromTime: "09:00", accessUntil: "2026-12-12" }, NZ).endsAt).not.toBeNull();
    expect(parseAccessWindow({}, NZ)).toEqual({ startsAt: null, endsAt: null });
  });

  it("knows the state now", () => {
    const now = new Date("2026-12-10T00:00:00Z");
    expect(accessState({ startsAt: null, endsAt: null }, now)).toBe("open");
    expect(accessState({ startsAt: null, endsAt: "2026-12-20T00:00:00Z" }, now)).toBe("current");
    expect(accessState({ startsAt: null, endsAt: "2026-12-12T11:00:00Z" }, now)).toBe("ending");
    expect(accessState({ startsAt: null, endsAt: "2026-12-10T00:00:00Z" }, now)).toBe("ended");
    expect(accessState({ startsAt: "2026-12-11T00:00:00Z", endsAt: null }, now)).toBe("not_started");
    expect(matchesAccessFilter("ending", "ending")).toBe(true);
    expect(matchesAccessFilter("current", "limited")).toBe(true);
    expect(matchesAccessFilter("open", "limited")).toBe(false);
    expect(matchesAccessFilter("ended", "ended")).toBe(true);
  });

  it("extends a week or a month from the end, or from today once ended, keeping a time of day", () => {
    const now = new Date("2026-12-10T00:00:00Z"); // 10 Dec, 1pm in New Zealand
    const end12 = zonedInstant("2026-12-13", null, NZ).toISOString(); // until 12 Dec
    expect(untilParts(extendedEnd(end12, "week", now, NZ), NZ)).toEqual({ date: "2026-12-19", time: null });
    expect(untilParts(extendedEnd(end12, "month", now, NZ), NZ)).toEqual({ date: "2027-01-12", time: null });
    const endedAtFive = zonedInstant("2026-12-01", "17:00", NZ).toISOString();
    expect(untilParts(extendedEnd(endedAtFive, "week", now, NZ), NZ)).toEqual({ date: "2026-12-17", time: "17:00" });
    expect(untilParts(extendedEnd(null, "week", now, NZ), NZ)).toEqual({ date: "2026-12-17", time: null });
    expect(addMonth("2027-01-31")).toBe("2027-02-28");
  });

  it("says plainly why someone is refused", () => {
    expect(accessRefusalMessage("ended", "Kōwhai Dairies", { date: "2026-12-12", time: null }, "Aroha Owner")).toBe(
      "Your access to Kōwhai Dairies ended on 12 Dec 2026. Ask Aroha Owner to extend it.",
    );
    expect(accessRefusalMessage("not_started", "Kōwhai Dairies", { date: "2026-12-01", time: "09:00" }, null)).toBe(
      "Your access to Kōwhai Dairies starts on 1 Dec 2026, 9:00am. Ask an owner of the organisation if you need it sooner.",
    );
  });

  it("names audit events plainly", () => {
    expect(describeEvent("invoice.approved")).toBe("Invoice approved");
    expect(describeEvent("organisation.member_access_set")).toBe("Member access set");
    expect(describeEvent("bank_line.matched")).toBe("Bank line matched");
  });
});
