import { describe, expect, it } from "vitest";
import {
  confidenceText,
  gstProblem,
  matchesFilter,
  proposalCountsText,
  proposalCsv,
  proposalTotals,
  rowState,
  staleReasons,
} from "@/lib/bank/coding-proposal-words";

describe("bank coding proposals: the shared rules (#544)", () => {
  it("shows posted and failed from the approval's batch action, never approved for an AI draft", () => {
    expect(rowState("proposed", null)).toBe("proposed");
    expect(rowState("rejected", null)).toBe("rejected");
    expect(rowState("approved", "pending")).toBe("approved");
    expect(rowState("approved", "started")).toBe("approved");
    expect(rowState("approved", "committed")).toBe("posted");
    expect(rowState("approved", "failed")).toBe("failed");
  });

  it("flags a stale row instead of following the line's changes (BCP4)", () => {
    const seen = { date: "2026-07-20", amount: "-46.00", reconciliations: 0 };
    expect(staleReasons(seen, { ...seen, status: "unreconciled" })).toEqual([]);
    expect(staleReasons(seen, { ...seen, amount: "-46", status: "unreconciled" })).toEqual([]);
    expect(staleReasons(seen, { ...seen, status: "reconciled", reconciliations: 1 })).toEqual(["The line is now reconciled."]);
    expect(staleReasons(seen, { ...seen, status: "unreconciled", reconciliations: 2 })).toEqual([
      "The line was reconciled and unreconciled since this was proposed.",
    ]);
    expect(staleReasons(seen, { date: "2026-07-21", amount: "-47.00", reconciliations: 0, status: "unreconciled" })).toEqual([
      "The line's date has changed.",
      "The line's amount has changed.",
    ]);
  });

  it("checks the GST treatment as #546 does for an AI (BCP6)", () => {
    expect(gstProblem("registered", null, "standard")).toMatch(/Nothing supports the GST/);
    expect(gstProblem("registered", "tax_document", "standard")).toBeNull();
    expect(gstProblem("registered", "person_said", null)).toBeNull();
    expect(gstProblem("registered", null, null)).toMatch(/Nothing supports/);
    expect(gstProblem("registered", "no_gst_supply", "standard")).toMatch(/Says no GST/);
    expect(gstProblem("unconfirmed", "tax_document", "standard")).toMatch(/isn't confirmed/);
    expect(gstProblem("unconfirmed", null, null)).toBeNull();
    expect(gstProblem("unconfirmed", null, "out_of_scope")).toBeNull();
    expect(gstProblem("not_registered", null, "standard")).toMatch(/Not registered/);
    expect(gstProblem("not_registered", null, null)).toBeNull();
  });

  it("totals by account and by tax code, money in and out apart, without rejected rows (BCP2)", () => {
    const row = (state: "proposed" | "rejected" | "posted", lineAmount: string, accountCode: string, taxCode: string | null) => ({
      state,
      lineAmount,
      accountCode,
      accountName: accountCode === "6120" ? "Motor vehicle" : "Bank fees",
      taxCode,
      taxLabel: taxCode ? "GST on expenses" : null,
    });
    const totals = proposalTotals([
      row("proposed", "-46.00", "6120", "GST"),
      row("posted", "-23.45", "6120", "GST"),
      row("proposed", "-5.00", "6040", null),
      row("proposed", "10.10", "6040", null),
      row("rejected", "-1000.00", "6120", "GST"),
    ]);
    expect(totals.rows).toBe(4);
    expect(totals.moneyOut).toBe("74.45");
    expect(totals.moneyIn).toBe("10.10");
    expect(totals.byAccount).toEqual([
      { key: "6040", label: "6040 Bank fees", rows: 2, moneyIn: "10.10", moneyOut: "5.00" },
      { key: "6120", label: "6120 Motor vehicle", rows: 2, moneyIn: "0.00", moneyOut: "69.45" },
    ]);
    expect(totals.byTax).toEqual([
      { key: "GST", label: "GST GST on expenses", rows: 2, moneyIn: "0.00", moneyOut: "69.45" },
      { key: "", label: "No GST", rows: 2, moneyIn: "10.10", moneyOut: "5.00" },
    ]);
  });

  it("filters by state, and 'Needs a look' picks open rows with a problem", () => {
    const stale = { state: "proposed" as const, problems: [{ kind: "stale" as const, text: "x" }] };
    const clean = { state: "proposed" as const, problems: [] };
    const failed = { state: "failed" as const, problems: [{ kind: "locked" as const, text: "y" }] };
    expect(matchesFilter(stale, "attention")).toBe(true);
    expect(matchesFilter(clean, "attention")).toBe(false);
    expect(matchesFilter(failed, "attention")).toBe(true);
    expect(matchesFilter(failed, "failed")).toBe(true);
    expect(matchesFilter(clean, "posted")).toBe(false);
    expect(matchesFilter(clean, "all")).toBe(true);
  });

  it("exports CSV safely: quotes commas and stops spreadsheet formulas", () => {
    const csv = proposalCsv([
      {
        id: "7",
        lineId: "70",
        line: { date: "2026-07-20", description: "Z ENERGY, DUNEDIN", amount: "-46.00" },
        state: "proposed",
        contactName: "=HYPERLINK(1)",
        accountCode: "6120",
        taxCode: "GST",
        description: "Fuel",
        confidence: "0.9",
        gstEvidence: "tax_document",
        rationale: 'Said "fuel"',
        evidence: null,
        problems: [],
        error: null,
      },
    ]);
    const [header, line] = csv.trim().split("\r\n");
    expect(header.split(",")[0]).toBe("Row");
    expect(line).toBe(`7,70,2026-07-20,"Z ENERGY, DUNEDIN",-46.00,Proposed,'=HYPERLINK(1),6120,GST,Fuel,0.9,Tax invoice or receipt,"Said ""fuel""",,`);
  });

  it("words", () => {
    expect(proposalCountsText({ proposed: 3, approved: 1, posted: 2, failed: 0, rejected: 1 })).toBe("3 proposed, 1 waiting to post, 2 posted, 1 rejected");
    expect(proposalCountsText({})).toBe("No rows");
    expect(confidenceText("0.85")).toBe("85%");
    expect(confidenceText("1")).toBe("100%");
    expect(confidenceText("0.5")).toBe("50%");
    expect(confidenceText(null)).toBe("—");
  });
});
