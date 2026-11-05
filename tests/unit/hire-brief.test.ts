import { describe, expect, it } from "vitest";
import { accessUntilFor, type HireChoices, type HireFacts, inviteHref, writeBrief } from "@/lib/organisations/hire-brief";

const FACTS: HireFacts = {
  bankAccounts: 3,
  unreconciledLines: 214,
  unreconciledFrom: "2026-03",
  unreconciledTo: "2026-10",
  unreconciledMonths: 8,
  gstRegistered: true,
  gstPeriodMonths: 2,
  gstBasis: "invoice",
  financialYearEndMonth: 3,
  modules: ["Accounting", "Farming"],
  employees: 4,
};

const CHOICES: HireChoices = { tasks: ["bank_reconciliation", "gst_return"], catchUpMonths: 3, role: "bookkeeper", startDate: "2026-11-10", length: "1_month", untilDate: "" };

/** Hire help (decisions 1475-1480): the brief is written from counts and periods only. */
describe("hiring brief", () => {
  it("writes the tasks from the books' facts", () => {
    const brief = writeBrief(FACTS, CHOICES);
    expect(brief).toContain("- Bank reconciliation: about 214 bank statement lines across 3 bank or card accounts aren't reconciled yet, from March 2026 to October 2026 (8 months with lines to do).");
    expect(brief).toContain("- GST return: GST is filed two-monthly on the invoice basis.");
    expect(brief).toContain("- Bookkeeper access: you can enter and reconcile transactions, and can't change settings or people.");
    expect(brief).toContain("- From 10 Nov 2026 to 9 Dec 2026.");
    expect(brief).toContain("- Parts in use: Accounting, Farming.");
    expect(brief).not.toContain("Payroll");
  });

  it("covers every task", () => {
    const brief = writeBrief({ ...FACTS, gstPeriodMonths: null }, { ...CHOICES, tasks: ["catch_up", "year_end", "payroll", "set_up", "gst_return"], catchUpMonths: 6 });
    expect(brief).toContain("- Catch-up: bring the books up to date for the last 6 months.");
    expect(brief).toContain("- Year-end preparation: the financial year ends on the last day of March.");
    expect(brief).toContain("- Payroll: pay runs and payday filing for 4 employees.");
    expect(brief).toContain("- GST return: on the invoice basis (how often isn't set in the books yet).");
    expect(writeBrief({ ...FACTS, employees: null }, { ...CHOICES, tasks: ["payroll"] })).toContain("- Payroll: pay runs and payday filing.");
    expect(writeBrief({ ...FACTS, gstRegistered: false }, CHOICES)).toContain("isn't registered for GST yet");
  });

  it("has no names, amounts or hiring sites in it", () => {
    const brief = writeBrief(FACTS, { ...CHOICES, tasks: ["bank_reconciliation", "gst_return", "catch_up", "year_end", "payroll", "set_up"] });
    expect(brief).not.toMatch(/\$|\d+\.\d{2}/);
    expect(brief.toLowerCase()).not.toContain("upwork");
    expect(brief).toContain("a New Zealand organisation");
  });

  it("works out the last day and the invite link", () => {
    expect(accessUntilFor("2026-11-10", "1_week", "")).toBe("2026-11-16");
    expect(accessUntilFor("2026-11-10", "2_weeks", "")).toBe("2026-11-23");
    expect(accessUntilFor("2026-11-10", "1_month", "")).toBe("2026-12-09");
    expect(accessUntilFor("2026-11-10", "3_months", "")).toBe("2027-02-09");
    expect(accessUntilFor("2026-11-10", "custom", "2026-11-30")).toBe("2026-11-30");
    expect(inviteHref(CHOICES)).toBe("/operations/members?invite=1&role=bookkeeper&from=2026-11-10&until=2026-12-09");
  });
});
