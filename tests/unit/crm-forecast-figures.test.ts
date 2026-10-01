import { describe, expect, it } from "vitest";
import {
  attainment,
  categoriesFor,
  type ForecastItem,
  forecastFigures,
  forecastPeriods,
  inMeasure,
  opportunityRuleProblem,
  parseProbability,
  periodContaining,
  stageKeyFrom,
  stageRuleProblem,
  weightedAmount,
} from "@/lib/crm/forecast-figures";

/** Stage rules, weighted amounts, cumulative rollups, periods and attainment (examples CRMS2, CRMS5, CRMS8-CRMS10). */

describe("stage rules (CRMS2, CRMS5)", () => {
  it("probabilities are whole per cents from 0 to 100", () => {
    expect(parseProbability(0)).toBe(0);
    expect(parseProbability("75")).toBe(75);
    expect(parseProbability("90%")).toBe(90);
    expect(parseProbability(100)).toBe(100);
    expect(parseProbability(101)).toBeNull();
    expect(parseProbability("12.5")).toBeNull();
    expect(parseProbability(-1)).toBeNull();
    expect(parseProbability("")).toBeNull();
    expect(parseProbability(null)).toBeNull();
  });

  it("Closed won is 100% Closed, Closed lost 0% Omitted, Open never Closed", () => {
    expect(stageRuleProblem("open", 90, "commit")).toBeNull();
    expect(stageRuleProblem("open", 50, "closed")).toBe("Only a Closed won stage can be in the Closed forecast category.");
    expect(stageRuleProblem("won", 90, "closed")).toBe("A Closed won stage is 100% and in the Closed forecast category.");
    expect(stageRuleProblem("won", 100, "closed")).toBeNull();
    expect(stageRuleProblem("lost", 0, "pipeline")).toBe("A Closed lost stage is 0% and in the Omitted forecast category.");
    expect(stageRuleProblem("lost", 0, "omitted")).toBeNull();
    expect(opportunityRuleProblem("open", 20, "omitted")).toBeNull();
    expect(opportunityRuleProblem("open", 80, "closed")).toBe("Only a won opportunity can be in the Closed forecast category.");
    expect(opportunityRuleProblem("won", 90, "closed")).toBe("A won opportunity is 100% and in the Closed forecast category.");
    expect(opportunityRuleProblem("lost", 0, "omitted")).toBeNull();
    expect(categoriesFor("open")).toEqual(["pipeline", "best_case", "commit", "omitted"]);
    expect(categoriesFor("won")).toEqual(["closed"]);
  });

  it("a new stage's key comes from its name", () => {
    expect(stageKeyFrom("Negotiation")).toBe("negotiation");
    expect(stageKeyFrom("Won – renewal")).toBe("won_renewal");
    expect(stageKeyFrom("Hui ā-whānau")).toBe("hui_a_whanau");
    expect(stageKeyFrom("2nd meeting")).toBe("stage_2nd_meeting");
  });
});

describe("weighted amounts (CRMS5)", () => {
  it("amount × probability, rounded half up per opportunity", () => {
    expect(weightedAmount("2400.00", 10, 2)).toBe("240.00");
    expect(weightedAmount("2400.00", 75, 2)).toBe("1800.00");
    expect(weightedAmount("2400.00", 80, 2)).toBe("1920.00");
    expect(weightedAmount("333.33", 15, 2)).toBe("50.00");
    expect(weightedAmount("333.33", 0, 2)).toBe("0.00");
    expect(weightedAmount("1001", 33, 0)).toBe("330");
    expect(weightedAmount("1003", 50, 0)).toBe("502");
  });
});

const item = (amount: string, probability: number, forecastCategory: ForecastItem["forecastCategory"], stageType: ForecastItem["stageType"] = "open"): ForecastItem => ({
  amount,
  weightedAmount: weightedAmount(amount, probability, 2),
  forecastCategory,
  stageType,
});

describe("cumulative rollups (CRMS8)", () => {
  const jessOctober = [
    item("600.00", 100, "closed", "won"),
    item("2400.00", 90, "commit"),
    item("900.00", 75, "best_case"),
    item("1000.00", 50, "pipeline"),
    item("500.00", 0, "omitted", "lost"),
    item("300.00", 20, "omitted"),
  ];

  it("Jess's October in NZD", () => {
    expect(forecastFigures(jessOctober, 2)).toEqual({
      closed: "600.00",
      commit: "3000.00",
      bestCase: "3900.00",
      pipeline: "4300.00",
      weighted: "3335.00",
      count: 6,
    });
  });

  it("Ben's October, and both together", () => {
    const ben = [item("1250.00", 100, "closed", "won"), item("333.33", 15, "pipeline")];
    expect(forecastFigures(ben, 2)).toEqual({ closed: "1250.00", commit: "1250.00", bestCase: "1250.00", pipeline: "333.33", weighted: "50.00", count: 2 });
    expect(forecastFigures([...jessOctober, ...ben], 2)).toMatchObject({
      closed: "1850.00",
      commit: "4250.00",
      bestCase: "5150.00",
      pipeline: "4633.33",
      weighted: "3385.00",
    });
  });

  it("which opportunities each figure is made of", () => {
    const won = { forecastCategory: "closed", stageType: "won" } as const;
    const commit = { forecastCategory: "commit", stageType: "open" } as const;
    const best = { forecastCategory: "best_case", stageType: "open" } as const;
    const pipeline = { forecastCategory: "pipeline", stageType: "open" } as const;
    const omitted = { forecastCategory: "omitted", stageType: "open" } as const;
    expect([won, commit, best, pipeline, omitted].map((x) => inMeasure(x, "closed"))).toEqual([true, false, false, false, false]);
    expect([won, commit, best, pipeline, omitted].map((x) => inMeasure(x, "commit"))).toEqual([true, true, false, false, false]);
    expect([won, commit, best, pipeline, omitted].map((x) => inMeasure(x, "bestCase"))).toEqual([true, true, true, false, false]);
    expect([won, commit, best, pipeline, omitted].map((x) => inMeasure(x, "pipeline"))).toEqual([false, true, true, true, false]);
    expect([won, commit, best, pipeline, omitted].map((x) => inMeasure(x, "weighted"))).toEqual([false, true, true, true, false]);
  });

  it("nothing is all zeros", () => {
    expect(forecastFigures([], 2)).toEqual({ closed: "0.00", commit: "0.00", bestCase: "0.00", pipeline: "0.00", weighted: "0.00", count: 0 });
  });
});

describe("periods (CRMS8, CRMS9)", () => {
  it("months from the one containing the date", () => {
    expect(forecastPeriods("2026-10-02", "month", 3, 3)).toEqual([
      { start: "2026-10-01", end: "2026-10-31", label: "Oct 2026" },
      { start: "2026-11-01", end: "2026-11-30", label: "Nov 2026" },
      { start: "2026-12-01", end: "2026-12-31", label: "Dec 2026" },
    ]);
    expect(forecastPeriods("2026-12-31", "month", 3, 3).map((p) => p.label)).toEqual(["Dec 2026", "Jan 2027", "Feb 2027"]);
    expect(periodContaining("2028-02-10", "month", 3)).toEqual({ start: "2028-02-01", end: "2028-02-29", label: "Feb 2028" });
  });

  it("quarters of the financial year", () => {
    expect(periodContaining("2026-10-15", "quarter", 3)).toEqual({ start: "2026-10-01", end: "2026-12-31", label: "Oct-Dec 2026" });
    expect(periodContaining("2026-10-15", "quarter", 6)).toMatchObject({ start: "2026-10-01", end: "2026-12-31" });
    expect(periodContaining("2026-10-15", "quarter", 5)).toMatchObject({ start: "2026-09-01", end: "2026-11-30", label: "Sep-Nov 2026" });
    expect(periodContaining("2026-01-15", "quarter", 3)).toMatchObject({ start: "2026-01-01", end: "2026-03-31" });
    expect(periodContaining("2027-01-15", "quarter", 11)).toEqual({ start: "2026-12-01", end: "2027-02-28", label: "Dec 2026-Feb 2027" });
    expect(forecastPeriods("2026-10-01", "quarter", 2, 3).map((p) => p.start)).toEqual(["2026-10-01", "2027-01-01"]);
  });
});

describe("attainment (CRMS10)", () => {
  it("Closed ÷ quota as a percentage, 2 places, half up", () => {
    expect(attainment("600.00", "5000.00")).toBe("12.00");
    expect(attainment("0.00", "5000.00")).toBe("0.00");
    expect(attainment("1250.00", "1000.00")).toBe("125.00");
    expect(attainment("600.00", "10000.00")).toBe("6.00");
    expect(attainment("1.00", "3.00")).toBe("33.33");
    expect(attainment("2.00", "3.00")).toBe("66.67");
    expect(attainment("600.00", null)).toBeNull();
    expect(attainment("600.00", "0.00")).toBeNull();
  });
});
