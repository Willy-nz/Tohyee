import { describe, expect, it } from "vitest";
import { ageText, findAnimal, sexFrom, taggedText, tagKey, tagsInText } from "@/lib/farming/animal-rules";
import { averageOf, bcsText, defaultScale, parseAverage, parseScore, scoreSteps, tallySummary, targetsFor } from "@/lib/farming/bcs-rules";

/** Animal and BCS rules (AN1-AN9, BCS1-BCS8; common NZ practice, not yet reviewed). */
describe("animal rules", () => {
  it("matches tags as people type them", () => {
    expect(tagKey("YB 214")).toBe("yb214");
    expect(tagsInText("214, 233 and YB 12 / lame cows; #301")).toEqual(["214", "233", "yb", "12", "301"].filter((key) => /\d/.test(key)));
    expect(tagsInText(null)).toEqual([]);
    const animals = [
      { tag: "214", eid: "982000111" },
      { tag: "YB 12", eid: null },
    ];
    expect(findAnimal(animals, " yb12 ")).toBe(animals[1]);
    expect(findAnimal(animals, "982 000 111")).toBe(animals[0]);
    expect(findAnimal(animals, "999")).toBeNull();
  });

  it("says N of M head tagged, and ages in words", () => {
    expect(taggedText(0, 40)).toBeNull();
    expect(taggedText(32, 1200)).toBe("32 of 1,200 head tagged");
    expect(ageText("2024-08-15", "2026-11-05")).toBe("2 years 2 months");
    expect(ageText("2026-10-20", "2026-11-05")).toBe("2 weeks");
    expect(ageText("2027-01-01", "2026-11-05")).toBeNull();
  });

  it("reads sexes from a file's words", () => {
    expect([sexFrom("F"), sexFrom("Ewe"), sexFrom("bull"), sexFrom("steer"), sexFrom("x")]).toEqual(["female", "female", "male", "castrated", null]);
  });
});

describe("BCS rules", () => {
  it("BCS1 scales per kind, in half points", () => {
    expect([defaultScale("dairy_cattle"), defaultScale("beef_cattle"), defaultScale("sheep"), defaultScale("deer_red"), defaultScale("goats_dairy")]).toEqual(["1_10", "1_10", "1_5", "1_5", "1_5"]);
    expect(parseScore("4.5", "1_10")).toBe("4.5");
    expect(parseScore(5, "1_10")).toBe("5.0");
    expect(() => parseScore("4.3", "1_10")).toThrow("half points");
    expect(() => parseScore("5.5", "1_5")).toThrow("from 1 to 5");
    expect(() => parseScore("0.5", "1_5")).toThrow();
    expect(scoreSteps("1_5")).toEqual(["1.0", "1.5", "2.0", "2.5", "3.0", "3.5", "4.0", "4.5", "5.0"]);
    expect(parseAverage("2.85", "1_5")).toBe("2.9");
  });

  it("BCS2 a tally's average is weighted by head, to one place", () => {
    const summary = tallySummary({ "4.0": 12, "4.5": 30, "5": 8, "3.5": "" }, "1_10");
    expect(summary).toMatchObject({ head: 50, average: "4.5", lowest: "4.0", highest: "5.0", tally: { "4.0": 12, "4.5": 30, "5.0": 8 } });
    // Ewes: 20 at 2.5, 60 at 3.0, 20 at 3.5 is 3.0; 20 are below the year-round 3.0.
    expect(tallySummary({ "2.5": 20, "3": 60, "3.5": 20 }, "1_5", "3.0")).toMatchObject({ average: "3.0", belowFloor: 20 });
    expect(() => tallySummary({}, "1_5")).toThrow("at least one");
    expect(averageOf(["4.5", "5.0", "4.0"])).toBe("4.5");
    expect(averageOf([])).toBeNull();
    expect(bcsText({ score: "4.5", headScored: 50, tally: { "4.0": 12, "5.0": 8 } })).toBe("BCS 4.5 average of 50 (4.0 to 5.0)");
    expect(bcsText({ score: "5.0", headScored: null, tally: null })).toBe("BCS 5.0");
  });

  it("BCS4 targets only from a recognised NZ source, on its own scale", () => {
    expect(targetsFor("dairy_cattle", "1_10")!.targets.map((target) => target.score)).toEqual(["5.0", "5.5", "4.0", "4.5"]);
    expect(targetsFor("dairy_cattle", "1_5")).toBeNull();
    expect(targetsFor("beef_cattle", "1_10")!.floor).toEqual({ score: "4.0", words: "the minimum for all cows" });
    expect(targetsFor("sheep", "1_5")!.targets[0]).toMatchObject({ when: "All year", score: "3.0" });
    expect(targetsFor("goats_dairy", "1_5")).toBeNull();
  });
});
