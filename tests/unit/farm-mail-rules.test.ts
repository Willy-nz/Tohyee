import { describe, expect, it } from "vitest";
import { findDate, findTimes, nzDay, readEmail, stripQuoted } from "@/lib/farming/mail-rules";

/** Examples FC2-FC12 in docs/ACCOUNTING-EXAMPLES.md (the farm calendar, #319; not yet reviewed). */
const farms = [
  { id: "1", name: "Home farm" },
  { id: "2", name: "Runoff" },
];
// Mon 19 Oct 2026, 10:02am NZDT.
const sentAt = "2026-10-18T21:02:00Z";
const read = (text: string, subject: string | null = null, at = sentAt) => readEmail({ subject, text, sentAt: at, farms });

describe("reading farm arrangements from email (FC2-FC12)", () => {
  it("works out the email's day in New Zealand", () => {
    expect(nzDay(sentAt)).toBe("2026-10-19");
    expect(nzDay("2026-10-19T11:30:00Z")).toBe("2026-10-20");
  });

  it("FC2 a clear booking", () => {
    expect(read("Hi Jess, we've booked TB testing at the Home farm for Thursday 22 October at 9am.", "TB testing")).toEqual([
      {
        kind: "animal_health",
        title: "TB testing",
        date: "2026-10-22",
        startTime: "09:00",
        endTime: null,
        tentative: false,
        change: "new",
        checkReasons: [],
        farmIds: ["1"],
        excerpt: "Hi Jess, we've booked TB testing at the Home farm for Thursday 22 October at 9am.",
      },
    ]);
  });

  it("FC3 tentative wording, and a weekday on its own", () => {
    const [item] = read("The fert truck should be there Tuesday, weather permitting.");
    expect([item.kind, item.title, item.date, item.startTime, item.tentative, item.checkReasons]).toEqual(["delivery", "Fert truck", "2026-10-20", null, true, []]);
    expect(read("Spraying is pencilled in for Friday.")[0]).toMatchObject({ date: "2026-10-23", tentative: true });
    expect(read("Shearing next Tuesday.")[0]).toMatchObject({ date: "2026-10-20", checkReasons: ["'next Tuesday' could mean 20 October 2026 or the week after"] });
  });

  it("FC4 no exact date goes to checking", () => {
    expect(read("The spreader will come early next week.")).toEqual([
      expect.objectContaining({ kind: "contractor", title: "Spreader", date: null, checkReasons: ["No exact date: 'early next week'"] }),
    ]);
    // From the subject only, "soon" isn't enough.
    expect(read("Thanks, see you soon.", "Spreading")).toEqual([]);
  });

  it("FC5 dates and times", () => {
    expect(read("Shearers arriving 7.30am on 3/11.")[0]).toMatchObject({ kind: "contractor", date: "2026-11-03", startTime: "07:30", endTime: null });
    expect(read("Vet coming between 9 and 11am on 3 November.")[0]).toMatchObject({ date: "2026-11-03", startTime: "09:00", endTime: "11:00" });
    expect(read("Mowing 9am-12pm on 3rd Nov")[0]).toMatchObject({ startTime: "09:00", endTime: "12:00" });
    expect(read("Baling from 11 to 1pm, November 3")[0]).toMatchObject({ date: "2026-11-03", startTime: "11:00", endTime: "13:00" });
    expect(findDate("delivery 3/11/26", "2026-10-19")?.date).toBe("2026-11-03");
    expect(findDate("delivery 03.11.2026", "2026-10-19")?.date).toBe("2026-11-03");
    expect(findDate("delivery tomorrow", "2026-10-19")?.date).toBe("2026-10-20");
    expect(findDate("delivery today", "2026-10-19")?.date).toBe("2026-10-19");
    expect(findDate("delivery 3 January", "2026-10-19")?.date).toBe("2027-01-03");
    expect(findDate("delivery 14 October", "2026-10-19")?.date).toBe("2026-10-14");
    expect(findDate("delivery 31 February", "2026-10-19")).toBeNull();
    expect(findTimes("at 14:00")).toEqual({ start: "14:00", end: null });
    expect(findTimes("midday")).toEqual({ start: "12:00", end: null });
    // 7.30am isn't a date.
    expect(findDate("arriving 7.30am", "2026-10-19")).toBeNull();
  });

  it("FC6 a weekday that doesn't match the date", () => {
    expect(read("Drenching Thursday 23 October.")[0]).toMatchObject({ date: "2026-10-23", checkReasons: ["Thursday doesn't match 23 October 2026 (a Friday)"] });
    expect(read("Drenching Friday 23 October.")[0]).toMatchObject({ date: "2026-10-23", checkReasons: [] });
  });

  it("FC7, FC8 moved and cancelled", () => {
    expect(read("Sorry, we've had to move the TB testing to Friday 23 October at 9am.")[0]).toMatchObject({ change: "moved", date: "2026-10-23", startTime: "09:00" });
    expect(read("The shearing has been postponed to 30 October.")[0]).toMatchObject({ change: "moved", date: "2026-10-30" });
    // Moving stock isn't a booking moving.
    expect(read("We're moving the heifers to the Runoff, stock truck Wednesday 21 October.")[0]).toMatchObject({ kind: "stock_movement", change: "new", farmIds: ["2"] });
    expect(read("The stock truck for Wednesday is cancelled.")[0]).toMatchObject({ kind: "stock_movement", change: "cancelled", date: "2026-10-21" });
    expect(read("Sorry, the stock truck is cancelled.")[0]).toMatchObject({ change: "cancelled", date: null, checkReasons: [] });
  });

  it("FC9 quoted earlier messages aren't read again", () => {
    const reply = "Great, thanks.\n\nOn Mon, 19 Oct 2026 at 10:02, Manuka Vets <office@manukavets.example> wrote:\n> We've booked TB testing for Thursday 22 October at 9am.";
    expect(stripQuoted(reply).trim()).toBe("Great, thanks.");
    expect(read(reply)).toEqual([]);
    expect(read("Thanks\n> TB testing Thursday 22 October")).toEqual([]);
    expect(read("Thanks\nFrom: Manuka Vets\nSent: Monday\nSubject: TB\nTB testing Thursday 22 October")).toEqual([]);
    // The same arrangement twice in one email is one item.
    expect(read("TB testing on 22 October. Reminder: TB testing on 22 October.")).toHaveLength(1);
  });

  it("FC10, FC11 farms", () => {
    expect(read("Spraying the Runoff and the Home farm on Wednesday 21 October.")[0]).toMatchObject({
      farmIds: ["1", "2"],
      checkReasons: ["Mentions more than one farm: Home farm, Runoff"],
    });
    // A farm in the subject counts when the sentence names none.
    expect(read("Spraying on 21 October.", "Runoff spraying")[0]).toMatchObject({ farmIds: ["2"] });
    expect(read("Spraying on 21 October.")[0]).toMatchObject({ farmIds: [] });
    // Whole words only: "Runoffs" isn't "Runoff".
    expect(read("Spraying the Runoffs on 21 October.")[0]).toMatchObject({ farmIds: [] });
  });

  it("FC12 not farm arrangements", () => {
    expect(read("Our sale ends 31 October.")).toEqual([]);
    expect(read("Thanks for the delivery.")).toEqual([]);
    expect(read("Feedback form closes 31 October.")).toEqual([]);
    // The arrangement in the subject and the date in the text.
    expect(read("Booked for Thursday 22 October at 9am.", "TB testing")[0]).toMatchObject({ kind: "animal_health", title: "TB testing", date: "2026-10-22" });
    expect(read("NAIT movements must be done by 2 November.")[0]).toMatchObject({ kind: "deadline", date: "2026-11-02" });
    expect(read("Discussion group field day on 5 November.")[0]).toMatchObject({ kind: "meeting" });
  });
});
