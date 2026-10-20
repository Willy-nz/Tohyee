import { describe, expect, it } from "vitest";
import { BUYING_ROLE_LABELS, BUYING_ROLES, goalProgress, renewalWhen } from "@/lib/crm/account-plan-types";

/** Decisions 653-654: how plans and renewals read. */
describe("account plan words", () => {
  it("says when a renewal is", () => {
    expect(renewalWhen("2026-10-20", "2026-10-20")).toBe("today");
    expect(renewalWhen("2026-10-21", "2026-10-20")).toBe("tomorrow");
    expect(renewalWhen("2026-11-19", "2026-10-20")).toBe("in 30 days");
    expect(renewalWhen("2026-10-17", "2026-10-20")).toBe("3 days ago");
    // Across the daylight saving change (dates, not times).
    expect(renewalWhen("2027-04-05", "2027-04-03")).toBe("in 2 days");
  });

  it("counts goals achieved, leaving dropped ones out", () => {
    expect(goalProgress([])).toBe("No goals yet");
    expect(goalProgress([{ status: "achieved" }, { status: "open" }, { status: "dropped" }])).toBe("1 of 2 goals achieved");
  });

  it("names every buying role", () => {
    expect(BUYING_ROLES.map((role) => BUYING_ROLE_LABELS[role])).toEqual(["Decision maker", "Budget holder", "Champion", "Influencer", "User", "Blocker", "Other"]);
  });
});
