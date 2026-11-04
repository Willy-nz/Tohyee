import { describe, expect, it } from "vitest";
import { type GstRegistration, gstRegistrationForPeriod } from "@/lib/tax/registration";

/**
 * Issue #577, examples GSR11-GSR14 in docs/ACCOUNTING-EXAMPLES.md: the GST
 * return says whether registration covers all, part or none of the period.
 */
const reg = (overrides: Partial<GstRegistration> = {}): GstRegistration => ({
  registered: true,
  from: null,
  until: null,
  organisationName: "Kowhai Crafts",
  confirmed: true,
  ...overrides,
});

describe("GST registration for a return period (#577)", () => {
  it("GSR11: not registered at all: no return, and it isn't a nil return", () => {
    const answer = gstRegistrationForPeriod(reg({ registered: false }), "2026-09-01", "2026-10-31");
    expect(answer).toMatchObject({ status: "not_registered", confirmed: true, registered: false, coveredFrom: null, coveredUntil: null });
    expect(answer.note).toBe(
      "Kowhai Crafts isn't registered for GST for 2026-09-01 to 2026-10-31 (Settings say it isn't registered for GST), so there's no GST return for this period: it isn't a nil return.",
    );
  });

  it("GSR11: registered from a later date, or deregistered before the period", () => {
    expect(gstRegistrationForPeriod(reg({ from: "2026-11-01" }), "2026-09-01", "2026-10-31")).toMatchObject({
      status: "not_registered",
      note: expect.stringContaining("(it's registered for GST from 2026-11-01)"),
    });
    expect(gstRegistrationForPeriod(reg({ until: "2026-08-31" }), "2026-09-01", "2026-10-31")).toMatchObject({
      status: "not_registered",
      note: expect.stringContaining("(its GST registration ended 2026-08-31)"),
    });
  });

  it("GSR14: registered and confirmed for the whole period: no warning", () => {
    expect(gstRegistrationForPeriod(reg({ from: "2026-11-01" }), "2026-11-01", "2026-12-31")).toMatchObject({
      status: "registered",
      coveredFrom: "2026-11-01",
      coveredUntil: "2026-12-31",
      note: "Kowhai Crafts is registered for GST for the whole period.",
    });
  });

  it("GSR13: a period that straddles the registration date says so", () => {
    const starts = gstRegistrationForPeriod(reg({ from: "2026-10-15" }), "2026-09-01", "2026-10-31");
    expect(starts).toMatchObject({ status: "partly_registered", from: "2026-10-15", coveredFrom: "2026-10-15", coveredUntil: "2026-10-31" });
    expect(starts.note).toBe(
      "Kowhai Crafts is registered for GST for only part of 2026-09-01 to 2026-10-31 (registration starts 2026-10-15). Only 2026-10-15 to 2026-10-31 belongs on a GST return; check the period with Inland Revenue.",
    );
    const ends = gstRegistrationForPeriod(reg({ from: "2025-01-01", until: "2027-03-15" }), "2027-02-01", "2027-03-31");
    expect(ends).toMatchObject({ status: "partly_registered", coveredFrom: "2027-02-01", coveredUntil: "2027-03-15", note: expect.stringContaining("registration ended 2027-03-15") });
  });

  it("GSR14: not confirmed: the figures rest on the setting, and the note says so", () => {
    const answer = gstRegistrationForPeriod(reg({ confirmed: false }), "2026-09-01", "2026-10-31");
    expect(answer).toMatchObject({ status: "registered", confirmed: false });
    expect(answer.note).toContain("GST registration hasn't been confirmed yet");
    expect(gstRegistrationForPeriod(reg({ registered: false, confirmed: false }), "2026-09-01", "2026-10-31").note).toContain("hasn't been confirmed yet");
  });
});
