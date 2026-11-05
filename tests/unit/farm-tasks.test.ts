import { describe, expect, it } from "vitest";
import { dueOnOrAfter, nextDue, repeatText, taskDates, taskState } from "@/lib/farming/tasks-rules";

/** Farm team tasks' rules (FT3, FT4, FT6; decisions 1457-1461, not yet reviewed). */
describe("farm task rules", () => {
  it("FT3 a one-off is due on its day until it's done", () => {
    const task = { dueOn: "2026-11-10", repeat: null };
    expect(nextDue(task, null)).toBe("2026-11-10");
    expect(nextDue(task, "2026-11-10")).toBeNull();
    expect(dueOnOrAfter(task, "2026-11-11")).toBeNull();
    expect(repeatText(null)).toBe("Once");
  });

  it("FT4 a repeating task moves to its next date after the one done; missed dates before it aren't owed", () => {
    const weekly = { dueOn: "2026-11-02", repeat: "weekly" as const };
    expect(nextDue(weekly, null)).toBe("2026-11-02");
    expect(nextDue(weekly, "2026-11-02")).toBe("2026-11-09");
    // Done late, for the 23rd: the next one is the 30th, not the 9th or 16th.
    expect(nextDue(weekly, "2026-11-23")).toBe("2026-11-30");
    const monthly = { dueOn: "2026-01-31", repeat: "monthly" as const };
    expect(nextDue(monthly, "2026-01-31")).toBe("2026-02-28");
    expect(nextDue(monthly, "2026-02-28")).toBe("2026-03-31");
    expect(repeatText("fortnightly")).toBe("every 2 weeks");
  });

  it("FT4 overdue from the day after it's due; this week is the next 7 days", () => {
    expect(taskState("2026-11-04", "2026-11-05")).toBe("overdue");
    expect(taskState("2026-11-05", "2026-11-05")).toBe("today");
    expect(taskState("2026-11-12", "2026-11-05")).toBe("soon");
    expect(taskState("2026-11-13", "2026-11-05")).toBe("later");
    expect(taskState(null, "2026-11-05")).toBe("done");
  });

  it("FT6 a repeating task's calendar dates run from the one it's next due", () => {
    const fortnightly = { dueOn: "2026-10-01", repeat: "fortnightly" as const };
    expect(taskDates(fortnightly, "2026-10-29", "2026-10-01", "2026-12-01")).toEqual(["2026-10-29", "2026-11-12", "2026-11-26"]);
    expect(taskDates({ dueOn: "2026-11-10", repeat: null }, "2026-11-10", "2026-11-01", "2026-11-30")).toEqual(["2026-11-10"]);
    expect(taskDates({ dueOn: "2026-11-10", repeat: null }, null, "2026-11-01", "2026-11-30")).toEqual([]);
    // The 31st each month, from February's (28th) on: March is still the 31st.
    expect(taskDates({ dueOn: "2026-01-31", repeat: "monthly" }, "2026-02-28", "2026-02-01", "2026-03-31")).toEqual(["2026-02-28", "2026-03-31"]);
  });
});
