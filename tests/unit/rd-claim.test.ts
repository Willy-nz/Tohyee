import { describe, expect, it } from "vitest";
import { calculateClaim, type ClaimBucketInput } from "@/lib/rd/claim-figures";
import { dueReminders, rdDeadlines } from "@/lib/rd/deadlines";

/**
 * The R&D claim's figures (RD16-RD20, RD26, RD36, RD40) and deadlines (RD24,
 * RD25, RD41) in docs/ACCOUNTING-EXAMPLES.md, stage R3. Pure: no database.
 */

const SENSOR = "Low-power soil sensor";

function bucket(fields: Partial<ClaimBucketInput> & Pick<ClaimBucketInput, "activityId" | "category" | "amount">): ClaimBucketInput {
  return {
    activityCode: fields.activityId,
    projectName: SENSOR,
    kind: fields.activityId.startsWith("C") ? "core" : "supporting",
    overseas: false,
    internalSoftware: false,
    commercialProduction: false,
    carriedIn: false,
    ...fields,
  };
}

/** Kea's 2026-27 year (RD16, RD26). */
const KEA: ClaimBucketInput[] = [
  bucket({ activityId: "C1", category: "employee", amount: "56000.00" }),
  bucket({ activityId: "C1", category: "materials_overheads", amount: "11400.00" }),
  bucket({ activityId: "C1", category: "depreciation", amount: "800.00" }),
  bucket({ activityId: "C1", category: "contract", amount: "3100.00" }),
  bucket({ activityId: "S1", category: "employee", amount: "1300.00" }),
  bucket({ activityId: "S1", category: "employee", amount: "600.00", carriedIn: true }),
  bucket({ activityId: "S2", category: "contract", amount: "9000.00", overseas: true }),
];

describe("the claim (RD16-RD20, RD26)", () => {
  it("RD16 and RD26: Kea's 2026-27 claim, the overseas limit, the credit and the return's figures", () => {
    const claim = calculateClaim(KEA, 2);
    expect(claim).toMatchObject({
      nzTotal: "73200.00",
      overseasSpent: "9000.00",
      overseasLimit: "8133.33",
      overseasCounted: "8133.33",
      overseasOverLimit: "866.67",
      totalEligible: "81333.33",
      status: "meets_minimum",
      overMaximum: "0.00",
      claimed: "81333.33",
      credit: "12199.99",
      coreShare: "87.66",
    });
    expect(claim.projects).toHaveLength(1);
    expect(claim.projects[0]).toMatchObject({
      projectName: SENSOR,
      categories: {
        materials_overheads: "11400.00",
        depreciation: "800.00",
        employee: "57900.00",
        contract: "11233.33",
        approved_research_provider: "0.00",
      },
      overseasSpent: "9000.00",
      overseasCounted: "8133.33",
      overseasOverLimit: "866.67",
      total: "81333.33",
      coreAmount: "71300.00",
      supportingAmount: "10033.33",
      coreShare: "87.66",
      internalSoftware: "0.00",
      commercialProduction: "0.00",
      carriedIn: "600.00",
    });
    expect(claim.buckets.find((b) => b.activityId === "S2")).toMatchObject({ counted: "8133.33", overLimit: "866.67", claimed: "8133.33" });
  });

  it("RD17: under the minimum, only the approved research provider's 20,000.00 is claimed", () => {
    const claim = calculateClaim(
      [bucket({ activityId: "C1", category: "materials_overheads", amount: "10000.00" }), bucket({ activityId: "C1", category: "approved_research_provider", amount: "20000.00" })],
      2,
    );
    expect(claim).toMatchObject({ totalEligible: "30000.00", approvedResearchProvider: "20000.00", status: "approved_research_provider_only", claimed: "20000.00", credit: "3000.00" });
    expect(claim.projects[0].categories).toMatchObject({ materials_overheads: "0.00", approved_research_provider: "20000.00" });
    expect(claim.projects[0].total).toBe("20000.00");
  });

  it("RD18: the minimum is tested after the overseas limit, so 44,100.00 + 6,000.00 gives no credit", () => {
    const claim = calculateClaim(
      [bucket({ activityId: "C1", category: "employee", amount: "44100.00" }), bucket({ activityId: "S2", category: "contract", amount: "6000.00", overseas: true })],
      2,
    );
    expect(claim).toMatchObject({ overseasLimit: "4900.00", overseasCounted: "4900.00", totalEligible: "49000.00", status: "under_minimum", claimed: "0.00", credit: "0.00" });
    expect(claim.projects[0].total).toBe("0.00");
  });

  it("RD19: exactly 50,000.00 qualifies; 49,999.99 doesn't", () => {
    expect(calculateClaim([bucket({ activityId: "C1", category: "employee", amount: "50000.00" })], 2)).toMatchObject({ status: "meets_minimum", credit: "7500.00" });
    expect(calculateClaim([bucket({ activityId: "C1", category: "employee", amount: "49999.99" })], 2)).toMatchObject({ status: "under_minimum", credit: "0.00" });
  });

  it("RD20: the credit and the overseas limit are rounded down to the cent", () => {
    expect(calculateClaim([bucket({ activityId: "C1", category: "employee", amount: "50000.05" })], 2).credit).toBe("7500.00");
    const limited = calculateClaim(
      [bucket({ activityId: "C1", category: "employee", amount: "50000.00" }), bucket({ activityId: "S2", category: "contract", amount: "6000.00", overseas: true })],
      2,
    );
    expect(limited).toMatchObject({ overseasLimit: "5555.55", overseasCounted: "5555.55", totalEligible: "55555.55" });
  });

  it("RD36: the overseas limit is shared in proportion, the leftover cent to the largest remainder", () => {
    const claim = calculateClaim(
      [
        bucket({ activityId: "C1", category: "employee", amount: "73200.00" }),
        bucket({ activityId: "S2", category: "contract", amount: "5000.00", overseas: true }),
        bucket({ activityId: "S2", category: "materials_overheads", amount: "4000.00", overseas: true }),
      ],
      2,
    );
    const s2 = claim.buckets.filter((b) => b.activityId === "S2");
    expect(s2.map((b) => [b.category, b.counted, b.overLimit])).toEqual([
      ["contract", "4518.52", "481.48"],
      ["materials_overheads", "3614.81", "385.19"],
    ]);
    expect(claim.overseasCounted).toBe("8133.33");
    expect(claim.totalEligible).toBe("81333.33");
  });

  it("RD36: on a tie the earlier overseas amount gets the leftover cent", () => {
    const claim = calculateClaim(
      [
        bucket({ activityId: "C1", category: "employee", amount: "900.00" }),
        bucket({ activityId: "S2", category: "contract", amount: "50.00", overseas: true }),
        bucket({ activityId: "S2", category: "materials_overheads", amount: "50.00", overseas: true }),
        bucket({ activityId: "S3", category: "contract", amount: "50.00", overseas: true }),
      ],
      2,
    );
    // Limit 900.00 / 9 = 100.00, shared 33.333... each: 33.34, 33.33, 33.33.
    expect(claim.buckets.filter((b) => b.overseas).map((b) => b.counted)).toEqual(["33.34", "33.33", "33.33"]);
  });

  it("an overseas amount within the limit counts in full", () => {
    const claim = calculateClaim(
      [bucket({ activityId: "C1", category: "employee", amount: "90000.00" }), bucket({ activityId: "S2", category: "contract", amount: "1000.00", overseas: true })],
      2,
    );
    expect(claim).toMatchObject({ overseasLimit: "10000.00", overseasCounted: "1000.00", overseasOverLimit: "0.00", totalEligible: "91000.00" });
  });

  it("RD39: commercial production and internal software show as 'of which' figures", () => {
    const claim = calculateClaim(
      [
        bucket({ activityId: "C1", category: "employee", amount: "60000.00" }),
        bucket({ activityId: "C1", category: "employee", amount: "500.00", commercialProduction: true }),
        bucket({ activityId: "C1", category: "materials_overheads", amount: "700.00", internalSoftware: true }),
      ],
      2,
    );
    expect(claim.projects[0]).toMatchObject({ commercialProduction: "500.00", internalSoftware: "700.00", total: "61200.00" });
  });

  it("RD40: over the $120 million maximum, $120 million is claimed", () => {
    const claim = calculateClaim([bucket({ activityId: "C1", category: "employee", amount: "130000000.00" })], 2);
    expect(claim).toMatchObject({ totalEligible: "130000000.00", overMaximum: "10000000.00", claimed: "120000000.00", credit: "18000000.00" });
    expect(claim.projects[0].categories.employee).toBe("130000000.00");
  });

  it("projects are reported separately, with the core share of each", () => {
    const claim = calculateClaim(
      [
        bucket({ activityId: "C1", category: "employee", amount: "40000.00" }),
        bucket({ activityId: "C9", category: "employee", amount: "20000.00", projectName: "Battery chemistry" }),
        bucket({ activityId: "S9", category: "materials_overheads", amount: "10000.00", projectName: "Battery chemistry" }),
      ],
      2,
    );
    expect(claim.projects.map((project) => [project.projectName, project.total, project.coreShare])).toEqual([
      ["Battery chemistry", "30000.00", "66.66"],
      [SENSOR, "40000.00", "100.00"],
    ]);
    expect(claim.coreShare).toBe("85.71");
  });

  it("nothing counted gives no credit and no core share", () => {
    expect(calculateClaim([], 2)).toMatchObject({ totalEligible: "0.00", status: "nothing", credit: "0.00", coreShare: null, projects: [] });
  });
});

describe("deadlines (RD24, RD25, RD41)", () => {
  it("RD24: Kea's 2026-27 dates for a 31 March balance date", () => {
    const result = rdDeadlines(2027, 3);
    if (!result.supported) throw new Error("expected dates");
    expect(result.deadlines.map((d) => [d.kind, d.dueDate, d.dueWeekday, d.onTimeBy])).toEqual([
      ["criteria_methodologies", "2026-09-30", "Wednesday", "2026-09-30"],
      ["exceed_maximum", "2027-05-07", "Friday", "2027-05-07"],
      ["general_approval", "2027-06-30", "Wednesday", "2027-06-30"],
      ["material_change_variation", "2027-06-30", "Wednesday", "2027-06-30"],
      ["income_tax_return", "2027-07-07", "Wednesday", "2027-07-07"],
      ["supplementary_return", "2027-08-06", "Friday", "2027-08-06"],
      ["following_year_variation", "2028-06-30", "Friday", "2028-06-30"],
      ["last_filing", "2028-07-07", "Friday", "2028-07-07"],
    ]);
    expect(result.deadlines.every((d) => d.source.length > 0)).toBe(true);
  });

  it("RD41: weekend dates are on time on the next Monday, worked from the unmoved date", () => {
    const result = rdDeadlines(2028, 3);
    if (!result.supported) throw new Error("expected dates");
    const by = Object.fromEntries(result.deadlines.map((d) => [d.kind, d]));
    expect([by.general_approval.dueDate, by.general_approval.onTimeBy]).toEqual(["2028-06-30", "2028-06-30"]);
    expect([by.income_tax_return.dueDate, by.income_tax_return.onTimeBy]).toEqual(["2028-07-07", "2028-07-07"]);
    expect([by.supplementary_return.dueDate, by.supplementary_return.dueWeekday, by.supplementary_return.onTimeBy]).toEqual(["2028-08-06", "Sunday", "2028-08-07"]);
    expect([by.exceed_maximum.dueDate, by.exceed_maximum.onTimeBy]).toEqual(["2028-05-07", "2028-05-08"]);
    expect([by.criteria_methodologies.dueDate, by.criteria_methodologies.onTimeBy]).toEqual(["2027-09-30", "2027-09-30"]);
    expect([by.following_year_variation.dueDate, by.following_year_variation.onTimeBy]).toEqual(["2029-06-30", "2029-07-02"]);
    expect([by.last_filing.dueDate, by.last_filing.onTimeBy]).toEqual(["2029-07-07", "2029-07-09"]);
    // 2028-29: the income tax return's 7 Jul 2029 is a Saturday, but the
    // supplementary return is still 30 days after 7 Jul.
    const later = rdDeadlines(2029, 3);
    if (!later.supported) throw new Error("expected dates");
    const supplementary = later.deadlines.find((d) => d.kind === "supplementary_return")!;
    expect([supplementary.dueDate, supplementary.onTimeBy]).toEqual(["2029-08-06", "2029-08-06"]);
  });

  it("RD41: other balance dates aren't worked out", () => {
    const result = rdDeadlines(2027, 9);
    expect(result).toEqual({ supported: false, note: "Tohyee works these dates out only for a 31 March balance date; see IRD's R&D tax incentive due dates page." });
  });

  it("RD25 and RD41: reminders from 60 days before, until the date has passed, and general approval until one is entered", () => {
    const remind = (today: string, approvalEntered = false, materialChange = false) =>
      dueReminders({ incomeYear: 2027, yearEndMonth: 3, today, approvalEntered, materialChange }).map((r) => [r.kind, r.dueDate]);
    expect(remind("2027-04-30")).toEqual([]);
    expect(remind("2027-05-01")).toEqual([["general_approval", "2027-06-30"]]);
    expect(remind("2027-05-01", false, true)).toEqual([
      ["general_approval", "2027-06-30"],
      ["material_change_variation", "2027-06-30"],
    ]);
    expect(remind("2027-05-01", true)).toEqual([]);
    expect(remind("2027-06-07", true)).toEqual([["supplementary_return", "2027-08-06"]]);
    expect(remind("2027-06-30")).toEqual([
      ["general_approval", "2027-06-30"],
      ["supplementary_return", "2027-08-06"],
    ]);
    expect(remind("2027-07-01")).toEqual([["supplementary_return", "2027-08-06"]]);
    expect(remind("2027-08-06")).toEqual([["supplementary_return", "2027-08-06"]]);
    expect(remind("2027-08-07")).toEqual([]);
    expect(dueReminders({ incomeYear: 2027, yearEndMonth: 9, today: "2027-05-01", approvalEntered: false, materialChange: false })).toEqual([]);
  });

  it("a reminder stays until the Monday when its date falls on a weekend", () => {
    const remind = (today: string) => dueReminders({ incomeYear: 2028, yearEndMonth: 3, today, approvalEntered: true, materialChange: false }).map((r) => r.kind);
    expect(remind("2028-08-07")).toEqual(["supplementary_return"]);
    expect(remind("2028-08-08")).toEqual([]);
    const reminder = dueReminders({ incomeYear: 2028, yearEndMonth: 3, today: "2028-08-07", approvalEntered: true, materialChange: false })[0];
    expect(reminder).toMatchObject({ remindFrom: "2028-06-07", text: "R&D supplementary return for 2027-28 due Sunday 6 Aug 2028 (on time if received Monday 7 Aug 2028)" });
  });
});
