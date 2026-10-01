import { describe, expect, it } from "vitest";
import { liabilityChanges, postingLines } from "@/lib/payroll/leave/liability-posting";

/**
 * Examples HL52-HL56 in docs/ACCOUNTING-EXAMPLES.md (posting the leave
 * liability, decisions 177 and 182-187), the pure parts: the change by
 * Department since the last posting not voided, and the journal lines.
 */
describe("Leave liability posting lines (HL52-HL56)", () => {
  const workshop = "11";
  const office = "12";

  it("HL52: nothing posted before, so the change is the whole 6,327.45: Dr Leave expense / Cr Employee entitlements", () => {
    const changes = liabilityChanges([{ departmentId: workshop, liability: "6327.45" }], []);
    expect(changes).toEqual([{ departmentId: workshop, previous: "0.00", current: "6327.45", change: "6327.45" }]);
    expect(postingLines(changes.map((change) => ({ group: "1=11", change: change.change })))).toEqual([
      { group: "1=11", account: "expense", debit: "6327.45", credit: "0.00" },
      { group: "1=11", account: "liability", debit: "0.00", credit: "6327.45" },
    ]);
  });

  it("HL53: Hemi has finished, so the Department isn't in the report: 0.00 − 6,327.45, Dr Employee entitlements / Cr Leave expense", () => {
    const changes = liabilityChanges([], [{ departmentId: workshop, liability: "6327.45" }]);
    expect(changes).toEqual([{ departmentId: workshop, previous: "6327.45", current: "0.00", change: "-6327.45" }]);
    expect(postingLines([{ group: "1=11", change: "-6327.45" }])).toEqual([
      { group: "1=11", account: "liability", debit: "6327.45", credit: "0.00" },
      { group: "1=11", account: "expense", debit: "0.00", credit: "6327.45" },
    ]);
  });

  it("HL55: the week's holiday takes the liability from 6,327.45 to 5,204.25, a fall of 1,123.20", () => {
    expect(liabilityChanges([{ departmentId: workshop, liability: "5204.25" }], [{ departmentId: workshop, liability: "6327.45" }])).toEqual([
      { departmentId: workshop, previous: "6327.45", current: "5204.25", change: "-1123.20" },
    ]);
  });

  it("HL54, decision 182: nothing changed is nothing to post", () => {
    expect(liabilityChanges([{ departmentId: workshop, liability: "5204.25" }], [{ departmentId: workshop, liability: "5204.25" }])).toEqual([]);
    expect(postingLines([])).toEqual([]);
  });

  it("decision 185: a move between Departments posts both sides, and with advanced features off (one group) nets to nothing", () => {
    const changes = liabilityChanges(
      [
        { departmentId: office, liability: "1000.00" },
        { departmentId: null, liability: "50.00" },
      ],
      [{ departmentId: workshop, liability: "1000.00" }],
    );
    expect(changes).toEqual([
      { departmentId: office, previous: "0.00", current: "1000.00", change: "1000.00" },
      { departmentId: null, previous: "0.00", current: "50.00", change: "50.00" },
      { departmentId: workshop, previous: "1000.00", current: "0.00", change: "-1000.00" },
    ]);
    expect(postingLines([{ group: "1=12", change: "1000.00" }, { group: "", change: "50.00" }, { group: "1=11", change: "-1000.00" }])).toEqual([
      { group: "1=12", account: "expense", debit: "1000.00", credit: "0.00" },
      { group: "1=12", account: "liability", debit: "0.00", credit: "1000.00" },
      { group: "", account: "expense", debit: "50.00", credit: "0.00" },
      { group: "", account: "liability", debit: "0.00", credit: "50.00" },
      { group: "1=11", account: "liability", debit: "1000.00", credit: "0.00" },
      { group: "1=11", account: "expense", debit: "0.00", credit: "1000.00" },
    ]);
    expect(postingLines(changes.map((change) => ({ group: "", change: change.change })))).toEqual([
      { group: "", account: "expense", debit: "50.00", credit: "0.00" },
      { group: "", account: "liability", debit: "0.00", credit: "50.00" },
    ]);
    expect(postingLines([{ group: "", change: "1000.00" }, { group: "", change: "-1000.00" }])).toEqual([]);
  });
});
